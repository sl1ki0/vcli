import { installHostFileSystem } from "@vcli/core";
import { RootedFileSystem } from "./rooted-filesystem.ts";

installHostFileSystem((root, options) => new RootedFileSystem(root, options));
