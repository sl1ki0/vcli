/* macOS process-group supervisor. Seatbelt must prohibit every group escape. */
#include <sys/types.h>
#include <sys/event.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <sys/proc.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
static volatile sig_atomic_t stopped;
static void interrupted(int signal_number) { stopped = signal_number; }
static int watch(int queue, pid_t pid) {
  struct kevent event;
  EV_SET(&event, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_EXIT, 0, NULL);
  return kevent(queue, &event, 1, NULL, 0, NULL);
}
static int cap(int resource, rlim_t maximum) {
  struct rlimit current;
  if (getrlimit(resource, &current) < 0) return -1;
  if (current.rlim_cur > maximum) current.rlim_cur = maximum;
  if (current.rlim_max > maximum) current.rlim_max = maximum;
  return setrlimit(resource, &current);
}

/* Called inside the prepared Seatbelt profile before any untrusted payload. */
static int probe_detachment(void) {
  for (int operation = 0; operation < 3; operation++) {
    pid_t child = fork();
    if (child < 0) return 125;
    if (!child) {
      int result;
      errno = 0;
      if (!operation) result = setsid() < 0 ? errno : 0;
      else if (operation == 1) result = setpgid(0, 0) < 0 ? errno : 0;
      else {
        pid_t spawned;
        char *args[] = { "/usr/bin/true", NULL };
        result = posix_spawn(&spawned, args[0], NULL, NULL, args, environ);
        if (!result) while (waitpid(spawned, NULL, 0) < 0 && errno == EINTR) {}
      }
      _exit(result == EPERM || result == EACCES ? 0 : 125);
    }
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 125;
    if (!WIFEXITED(status) || WEXITSTATUS(status)) return 125;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe-detachment")) return probe_detachment();
  if (argc < 5 || strcmp(argv[1], "--parent") || strcmp(argv[3], "--")) return 125;
  char *end = NULL;
  long expected_parent = strtol(argv[2], &end, 10);
  if (!end || *end || expected_parent <= 1 || getppid() != expected_parent) return 125;
  int queue = kqueue();
  if (queue < 0 || watch(queue, (pid_t)expected_parent) < 0) {
    perror("System sandbox parent tracking"); return 125;
  }
  if (getppid() != expected_parent) return 125;
  struct sigaction handler;
  memset(&handler, 0, sizeof(handler));
  handler.sa_handler = interrupted;
  sigemptyset(&handler.sa_mask);
  sigaction(SIGTERM, &handler, NULL);
  sigaction(SIGINT, &handler, NULL);
  sigaction(SIGHUP, &handler, NULL);
  signal(SIGPIPE, SIG_IGN);
  int gate[2];
  if (pipe(gate) < 0) return 125;
  pid_t leader = fork();
  if (leader < 0) return 125;
  if (!leader) {
    close(gate[1]); close(queue);
    /* Do this before entering Seatbelt, where setpgid/setsid/spawn are denied. */
    if (setpgid(0, 0) < 0) _exit(125);
    char go;
    ssize_t result;
    do { result = read(gate[0], &go, 1); } while (result < 0 && errno == EINTR);
    close(gate[0]);
    if (result != 1 || go != 'G') _exit(125);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    int processes = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), NULL, 0);
    if (processes <= 0 || cap(RLIMIT_CORE, 0) < 0 || cap(RLIMIT_NOFILE, 256) < 0 ||
        cap(RLIMIT_FSIZE, 64 * 1024 * 1024) < 0 || cap(RLIMIT_CPU, 120) < 0 ||
        cap(RLIMIT_NPROC, (rlim_t)(processes / (int)sizeof(pid_t) + 64)) < 0) _exit(125);
    execv(argv[4], &argv[4]);
    dprintf(STDERR_FILENO, "System sandbox executable could not start: %s\n", strerror(errno));
    _exit(127);
  }
  close(gate[0]);
  /* Parent and child both set the group while the child remains gated. */
  if (setpgid(leader, leader) < 0 || watch(queue, leader) < 0 || stopped) {
    close(gate[1]); kill(leader, SIGKILL);
    while (waitpid(leader, NULL, 0) < 0 && errno == EINTR) {}
    return 125;
  }
  if (write(gate[1], "G", 1) != 1) stopped = SIGTERM;
  close(gate[1]);
  int leader_status = 0, leader_done = 0, failed = 0;
  while (!leader_done) {
    if (stopped) kill(-leader, SIGKILL);
    struct timespec interval = { 0, 50000000 };
    struct kevent events[2];
    int count = kevent(queue, NULL, 0, events, 2, &interval);
    if (count < 0) {
      if (errno == EINTR) continue;
      failed = 1; break;
    }
    for (int i = 0; i < count; i++) {
      if (events[i].flags & EV_ERROR) { failed = 1; stopped = SIGTERM; }
      if (!(events[i].fflags & NOTE_EXIT)) continue;
      if ((pid_t)events[i].ident == expected_parent) stopped = SIGTERM;
      if ((pid_t)events[i].ident == leader) leader_done = 1;
    }
  }
  /* The leader remains unreaped, reserving its PID until all group signals are sent. */
  pid_t members[8192];
  int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)leader, members, sizeof(members));
  int abandoned = bytes <= 0 || bytes >= (int)sizeof(members);
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++)
    if (members[i] > 0 && members[i] != leader) abandoned = 1;
  kill(-leader, SIGKILL);
  /* Only the immutable group is enumerated; ancestry/reparenting is irrelevant. */
  for (int attempt = 0; attempt < 100; attempt++) {
    int alive = 0;
    bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)leader, members, sizeof(members));
    if (bytes < 0 || bytes >= (int)sizeof(members)) { failed = 1; break; }
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
      if (members[i] <= 0 || members[i] == leader) continue;
      struct proc_bsdinfo info;
      int size = proc_pidinfo(members[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
      if (size == (int)sizeof(info) && info.pbi_pgid == (uint32_t)leader && info.pbi_status != SZOMB) alive = 1;
    }
    if (!alive) break;
    kill(-leader, SIGKILL);
    usleep(1000);
    if (attempt == 99) failed = 1;
  }
  while (waitpid(leader, &leader_status, 0) < 0 && errno == EINTR) {}
  close(queue);
  if (abandoned) dprintf(STDERR_FILENO, "Background subprocesses were terminated; background work is unsupported.\n");
  if (failed || abandoned) return 125;
  if (stopped) return 128 + stopped;
  if (WIFEXITED(leader_status)) return WEXITSTATUS(leader_status);
  if (WIFSIGNALED(leader_status)) return 128 + WTERMSIG(leader_status);
  return 125;
}
