# Opening projects

Open Project offers three sources:

- **New project:** choose a parent folder and name. Mingle creates a new folder, initializes Git on `main`, and makes an empty initial commit using your configured Git identity. Git must be installed and `user.name` / `user.email` configured. No project dependencies are installed.
- **Local folder:** browse from your home directory, type an absolute path or `~/` path, and open the current folder. Partial paths narrow the directory list but cannot add the parent accidentally. Opening an existing project reuses its metadata.
- **Git URL:** choose a destination parent and new folder name, then clone an HTTPS or SSH repository. Custom ports, private hosts and standard SSH account names are supported. Use your existing Git authentication; passwords/tokens in URLs, URL query strings and fragments are rejected. Cloning does not recurse into submodules.

Existing destination folders are never overwritten. If repository creation or cloning fails after the new folder is reserved, that folder is kept for inspection and the error explains how to proceed. No automatic push occurs.

## Folder navigation

The picker lists directories only. Arrow keys highlight folders, Enter navigates into one, Backspace goes up when the path input is not being edited, Escape returns to sources or closes, and Ctrl+Enter (Command+Enter on macOS) opens the current folder. Typed partial paths are completed by the server. Hidden dot folders are omitted by default; known credential directories and Git/runtime internals remain excluded. Symlinks and Windows junctions are checked as directories, then project opening resolves their canonical paths.

All filesystem decisions use the operating system running Mingle's local server, rather than the browser's operating system. Windows supports fully qualified drive paths and UNC share paths, with available drive roots in Locations. macOS exposes Filesystem and Volumes; Linux exposes Filesystem. Home uses Node's native `os.homedir()`. Names, directory paths and permission failures come from the filesystem; the UI does not invent Desktop/Documents locations or assume English folder names. Open in Files, Finder or File Explorer launches the host file manager with an argv array.

Listings are bounded to 2,000 matching directories, 20,000 scanned entries and a checked five-second scan budget. A single filesystem operation may still wait on the OS, particularly for disconnected network mounts. Limited listings are disclosed, and path completion/filtering can narrow the results. Four concurrent listing requests are allowed. Browsing never reads file contents. Existing project-scoped file access restrictions are retained.

## API

- `GET /api/directories?path=optional&query=optional&hidden=true|false` → `DirectoryListing`. Missing `path` starts at home; a missing last path component returns prefix matches in its parent and `canSelect: false`. A filesystem root can be browsed but cannot itself become a project.
- `POST /api/directories/reveal {path}` → `{ok:true}`; requires an existing directory.
- `POST /api/projects/new {name,parentPath}` → `Project`.
- `POST /api/projects/clone {url,name,parentPath}` → `Project`.
- Existing `POST /api/projects {name,path}` opens a selected folder.

Paths are resolved and checked again on the server. Git commands use argv arrays with hooks disabled, bounded output, and timeouts (10 seconds per initialization command; 45 seconds for cloning). Git's existing authentication and configured checkout filters remain Git-owned.

## Platform verification

The implementation uses Node's native filesystem/path APIs for Linux, Windows and macOS. Interactive verification in this workspace is on Linux; native Windows and macOS verification remains outstanding. Desktop release packaging currently targets Linux x86-64 separately from this picker implementation.

Checked on 2026-10-20: workspace typechecking and the production build pass. Linux inspection covered the real home-directory listing, partial-path completion with Add disabled, click navigation, Backspace to parent, Escape navigation, blank new/clone form guards, and a 900×700 viewport. Creation/cloning and file-manager launching were reviewed in code without creating repositories or launching external windows during this check. No automated tests or provider inference were run.

References: [Node filesystem directory entries](https://nodejs.org/api/fs.html#class-fsdirent), [native path semantics](https://nodejs.org/api/path.html), [home directories](https://nodejs.org/api/os.html#oshomedir), [Git clone](https://git-scm.com/docs/git-clone).
