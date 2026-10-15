# The method tree

A method is the tree of files under its root, so its Python modules, templates, images, `requirements.txt` and `README.md` travel with its bundles. The standard defines it in `mthds/docs/spec/method-tree.md`: which files belong (the membership rule), what a tree path is, how a file reference resolves, the tree digest, and the file entry a file travels as. This package implements all of it in `src/method-tree/`, exported from the package root (`mthds`), and checks it against the conformance corpus the other implementations run.

The module reads the file system, so it is Node-side and is not part of `mthds/protocol`. The wire types of a file entry (`TextFileEntry`, `Base64FileEntry`, `HashFileEntry`, `FileEntry`, `MethodFiles`) are pure and live in `src/protocol/file_entries.ts`.

## Module map

```
src/method-tree/
  lister.ts            listMethodTree(path, { limits, discover }): the walk and the membership rule
  tree.ts              MethodTree: root, entry, files, digest, readFile, toMethodFiles, resolveReference
  discovery.ts         findManifestDirectory: Manifest Discovery, stopping at a .git entry of any kind
  membership.ts        the membership rule's defaults and marker names, shared by the lister and the map reader
  file-reading.ts      reading a listed file: no link followed, no blocking on a pipe, streamed into SHA-256
  gitignore.ts         git's .gitignore matching (wildmatch.c and dir.c), ported byte for byte
  tree-path.ts         the tree path rule, byte-wise ordering, path collisions
  case-folding.ts      Unicode full case folding over the generated case-folding-table.ts
  digest.ts            the tree listing and the tree digest
  references.ts        the standard's ordered file reference steps, pure
  function-names.ts    locating a PipeFunc's function_name in the tree, pure
  file-entries.ts      reading a map of file entries, as a receiver does
  json-document.ts     a strict JSON reader that keeps duplicate keys and number lexemes
  exceptions.ts        MethodTreeError, TreeLimitExceededError and their codes
```

## Listing a tree

`listMethodTree(path)` takes a directory or a `.mthds` file and returns a `MethodTree`, or throws a `MethodTreeError` whose `code` is the refusal kind the standard and the corpus name (`symbolic_link`, `special_file`, `invalid_tree_path`, `normalization_collision`, `path_collision`, `lone_file_excluded`, `empty_tree`, `gitignore_not_utf8`), plus the codes of this implementation for what the standard does not name (`not_found`, `not_listable`, `manifest_invalid`, `limit_exceeded`). Its `names` lists the offending tree paths.

**The root.** A directory or a `.mthds` file is rooted at the nearest directory holding `METHODS.toml` at or above it, found by Manifest Discovery, which stops at an entry named `.git` of any kind (a directory, a submodule's or a worktree's file, a symbolic link). With none, a directory is its own root, and a `.mthds` file named alone is a tree of that one file: nothing beside it is read, `root` is `null` and the file's name is its tree path. `{ discover: false }` roots the tree at the directory handed over, as a dependency's tree is rooted at its package directory. A directory handed over is resolved to its real path. A lone file is resolved to its real path too, so a name typed in another case on a case-insensitive file system gives the tree path the file system holds, and the `.mthds` suffix is checked on that name; a lone file that is a symbolic link keeps its own name, only its parent being resolved, so it is refused as a link.

**The membership rule.** The walk visits each directory's entries in byte order of their names and keeps a file unless, in this order:

- a segment of its path starts with a dot;
- it lies in a `__pycache__` or `node_modules` directory;
- it lies in a Python virtual environment (a directory holding a `pyvenv.cfg` file or symbolic link), a nested repository (a directory below the root holding any entry named `.git`) or a nested package (a directory below the root holding its own `METHODS.toml`);
- a `.gitignore` file of the tree, or the manifest's `[package] exclude`, ignores it.

An excluded directory is never entered, so no `.gitignore` file inside it is read, and the errors (a symbolic link, a special file, a name that is not a valid tree path segment) are raised only for what the rule keeps. The patterns are decided before a directory is listed, so a directory they exclude is pruned even when it cannot be listed; when it can be, a marker inside it still names the rule, since the markers outrank the patterns. The walk records each exclusion, so `MethodTree.resolveReference` can say which rule and which directory keep out a file a reference reaches, looking inside an excluded directory, never through an excluded link. The defaults live in `membership.ts`, which the map reader reads too, so a sender and a receiver apply the same names.

**`.gitignore` files** are read with git's own semantics: `gitignore.ts` ports `wildmatch.c` and the pattern parsing and matching of `dir.c` from git v2.51.0, over bytes rather than UTF-16, so a glob's `?` matches one byte and a character class is ASCII, as in git. A deeper file's patterns take precedence over a shallower one's, the last matching pattern of a file decides, a negation cannot re-include a file under an excluded directory, and the manifest's patterns rank below every `.gitignore` file, as `core.excludesFile` does. A `.gitignore` is read only when it is a regular file; its bytes are decoded as UTF-8 after skipping a leading byte order mark, as git does, and bytes that are not UTF-8 refuse the tree with `gitignore_not_utf8`, naming its path from the root. Patterns are normalized to NFC before they are used. No npm package was taken for this: the ones available match on JavaScript strings and differ from git on trailing spaces, byte order marks and re-inclusion under an excluded parent, which the corpus checks. `tests/unit/method-tree/gitignore.test.ts` compares the lister against `git ls-files --others --exclude-standard` in scratch repositories, with git's configuration isolated from the machine, wherever git is installed.

**The manifest's `exclude`** is read from `METHODS.toml` at the root with the rest of the manifest left unread, so a manifest this package would refuse for another reason still lists. An `exclude` that is not an array of strings, or a `METHODS.toml` that is not TOML, refuses the tree with `manifest_invalid`.

**Names and collisions.** Every path is normalized to NFC, then checked against the tree path rule (`tree-path.ts`: no empty segment, no `.` or `..`, no backslash, colon or control character, no lone surrogate, at most 255 bytes a segment and 1024 bytes a path). Two names a directory holds that are equal once normalized refuse the tree with `normalization_collision`; two paths equal once case-folded, a file and a directory included, refuse it with `path_collision`, naming every path involved.

**Case folding.** JavaScript has no full case folding (`toLowerCase` is a case conversion, which leaves `ß` alone), so the package carries the table. `scripts/gen-case-folding.mjs` generates `src/method-tree/case-folding-table.ts` from `scripts/unicode/CaseFolding-17.0.0.txt`, the Unicode 17.0.0 file, keeping the entries of status C and F and leaving out the Turkic (T) and simple (S) ones; `CASE_FOLDING_UNICODE_VERSION` names the version. A path is normalized to NFC, folded and normalized to NFC again. `make case-folding` regenerates the table, and a test runs the generator's `--check` mode so the committed table cannot drift from its source. To move to a later Unicode version, replace the file in `scripts/unicode/` and run `make case-folding`.

**Limits.** A caller passes `limits: { maxFileSize, maxFileCount, maxTotalSize }`, each optional and none set by default. The walk counts sizes from `lstat` as it goes and stops at the first limit passed, before any file is hashed, with a `TreeLimitExceededError` naming the root, the limit, its maximum and the count reached.

**Hashing.** Once the walk has found the tree sound, each file is hashed with SHA-256 and the tree digest is computed (`digest.ts`): one line per file, the hash, two spaces and the tree path, sorted byte for byte and ended by a line feed, hashed again and written `sha256:` and 64 lowercase hexadecimal digits. A file is opened without following a link and without blocking on a named pipe, confirmed a regular file on its own descriptor, and streamed into the hash (`file-reading.ts`), so a file swapped for a link or a special file since the walk is refused as `symbolic_link` or `special_file`, and any other failure as `not_listable` naming the file. `MethodTree.readFile` reads a file the same way and refuses it if its bytes no longer match the listing, and `toMethodFiles()` gives the tree as a map of file entries, a file whose bytes are UTF-8 as its text and any other as `{ "base64": … }`, each defined as its own property so a file named `__proto__` travels like any other.

## File references and function names

`resolveFileReference` (pure) and `MethodTree.resolveReference` follow the standard's ordered steps, the first failing step deciding the refusal: in a template, a URL with a scheme, an authority or no path is not a file reference; a path written with a scheme, a leading `/` or a backslash is `reference_invalid`, and so is a URL whose path, percent-decoded segment by segment and strictly, holds an escaped `/`, `\` or control character, a malformed escape or bytes that are not UTF-8; the reference is normalized to NFC and joined to its holder's directory, with `..` allowed down to the root; a result climbing above the root is `reference_leaves_tree`, one that is not a tree path is `reference_not_a_tree_path`, a reference from a one-file tree is `reference_in_one_file_tree`, and a tree path the tree does not hold is `reference_not_in_tree`. A reference resolving to the root itself, with or without a trailing `/` (`../` from `templates/letter.html`, `./` from a root file), is refused as not in the tree, with `.` as what it resolved to.

`locateFunction` reads a PipeFunc's `function_name` as an import path from the root: the name is normalized to NFC, each segment must be a Python identifier that is not a keyword and that NFKC normalization leaves unchanged (a ligature such as `ﬁ` or a fullwidth letter refuses the name rather than mapping it), and the module before the last dot must be exactly one of `<path>.py` and `<path>/__init__.py` in the tree. A refusal names the function name as written.

## Reading a map of file entries

`readFileEntryMap(document, blobStore)` reads the `files` map a runner receives, from its JSON text, with the strict reader in `json-document.ts`, because the rules need what `JSON.parse` hides: a key given twice inside an entry object, and a `size` written `13.0` or `1.3e1` rather than as an integer. It refuses a key that is not already in NFC or not a tree path, a name the membership rule would exclude, Base64 that is not canonical (padded, standard alphabet, zero pad bits, checked by a loop so a payload of many megabytes is read like a small one), a `size` too large to be exact, a hash entry whose blob the store does not hold or whose bytes do not hash to its key, and colliding paths. The blob store is consulted only when the map is otherwise sound. A document that is not a JSON object is `malformed_document`. It returns the files with their bytes, and the tree digest.

## The lock

A locked package's entry records `digest`, the tree digest of the package, in place of the old `hash` (`src/package/lock-file.ts`). A lock entry still carrying `hash` is refused when the lock is parsed, with a message saying that running `lock` regenerates it (this package has no lock command of its own; nothing outside its tests reads a lock yet), and no old hash is ever verified. The digest is computed by listing the package directory with the membership rule, rooted at the directory (`discover: false`); a tree the standard refuses is raised as a `LockFileError`, or an `IntegrityError` when a cached package is verified. The standard reads a fetched package from its resolved commit's git objects as stored and takes a cached copy's files as written, without applying the rule again; listing a directory gives the same tree only when the directory is a clean checkout of that commit with no line-ending conversion, so reading a fetched package from its commit is still to be ported.

## `mthds files`

`mthds files [path]` lists the tree of a directory or of a `.mthds` file: its root (or the note that a lone file has no manifest above it), each file's size and tree path, the totals and the digest, so an author sees what will travel before anything travels. `--format json` prints the same as an object (`root`, `entry`, `files` with each `path`, `size` and `sha256`, `file_count`, `total_size`, `digest`). A refused tree fails with the refusal's message. See `CLI.md`.

## The conformance corpus

The corpus is `conformance/tests/method_tree/fixtures/method-tree-corpus.json`, self-contained, every case carrying its bytes. It is vendored, byte for byte, as `tests/fixtures/method-tree-corpus.json`, with `tests/fixtures/method-tree-corpus.source.json` recording the conformance commit it was copied at, whether the file had uncommitted changes then, and its SHA-256. `make vendor-tree-corpus` copies it from `../conformance`, and `make vendor-tree-corpus CONFORMANCE=<checkout>` from any other checkout or worktree. `tests/unit/method-tree/corpus-vendoring.test.ts` checks the copy against its record, and against the conformance checkout beside this repository when there is one. Never edit the copy: a case this package disagrees with is a case to change in conformance.

`tests/unit/method-tree/corpus.test.ts` runs it as `conformance/specs/mthds-method-tree.md` ("What an implementation runs") asks: every tree case is materialized in a scratch directory and listed, its references resolved and its function names located, every map case is read as a receiver reads it, and every path case goes through the tree path rule. A tree case needing what the host's file system lacks is skipped and reported as skipped: on macOS, whose default file system neither keeps two names differing only in case nor two names differing only in normalization, the cases needing those are skipped, and Linux runs every case.

## What the standard leaves to the implementation

- **Which refusal comes first.** A tree with several faults is refused for the first the walk meets, in byte order of the paths, then for a normalization collision, a path collision, an excluded lone file and an empty tree, in that order. A map is refused for an empty map, a duplicate key, an invalid tree path, an excluded name, a path collision, a malformed entry and a missing blob, in that order.
- **A lone file that is not a `.mthds` file** is refused as `not_listable`, since the standard defines a lone file's tree only for a bundle.
- **A manifest's `exclude` that cannot be read** refuses the tree (`manifest_invalid`) rather than listing it without the patterns.
- **A size too large for a JavaScript number** is read exactly and refused as a missing blob, since no store holds a blob that large.
