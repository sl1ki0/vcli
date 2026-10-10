// ELK's worker entry installs its message dispatcher on this isolated worker.
// Its in-process fallback misidentifies Bun's main-thread `self` as a worker.
import "elkjs/lib/elk-worker.min.js";
