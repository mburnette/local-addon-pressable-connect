# ConnectLocal for Pressable

A [Local](https://localwp.com) add-on that connects Local to WordPress sites on [Pressable](https://pressable.com). It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files (`wp-content`), database, or both to a Pressable site;
- **pull** them back into an existing Local site;
- **pull a Pressable site into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

Files move with rsync over SSH and the database with WP-CLI, the same tools Local Connect uses for WP Engine. The [Pressable API](https://my.pressable.com/documentation/api/v1) handles what it can around the transfer: listing your sites, finding each site's SSH username and domains, and purging the Edge Cache when WP-CLI can't.

| Step | WP Engine (built in) | ConnectLocal for Pressable |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | A Pressable API application (Client ID and Client Secret). Pressable's API can't add SSH keys, so you add Local's key once in MyPressable (**your profile → Settings → SSH Keys**). If you'd rather use a site's SSH password, type it when linking; it is stored encrypted. |
| Finding the site | CAPI install list | `GET /v1/sites` lists every site of the account, live sites first, then staging sites. |
| SSH login | From CAPI | `ssh.pressable.com`, port 22, with the site's SSH user from `GET /v1/sites/{id}/ftp`: the one belonging to you (matched by email), else the site owner's. |
| Backup | CAPI backup before push | Pressable makes daily backups of its own. The add-on also saves the current database on the server before replacing it. |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries and flags, but **only `wp-content`**: Pressable manages WordPress core itself. Pressable's caching drop-ins and the plugins it links in (Jetpack, Akismet, OnePress Login) are never replaced by a push. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same. Plus collation fixes between MySQL 8 and MariaDB 11, and automatic restore if an import fails. |
| Pull | rsync down, export remote DB, import, `search-replace //remote //local` | Same. It also replaces the site's other domains and the `www`/non-`www` twin. |
| Cache | Purge CDN/object/page cache | `wp cache flush` and `wp edge-cache purge` over SSH (Pressable's own WP-CLI command), with `DELETE /v1/sites/{id}/edge-cache` as a fallback |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from Pressable". It checks the connection first, creates the site with Local's `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |

## Requirements

- Local 6 or newer. Developed against **Local 10.2 on macOS**.
- A Pressable site. Every plan includes SSH, WP-CLI and rsync.
- Local's SSH key added to your Pressable user: MyPressable → **your profile → Settings → SSH Keys** ([Pressable's guide](https://pressable.com/knowledgebase/connect-to-ssh-on-pressable/)). Keys belong to your user and work on every site you can reach. Pressable allows 5 per user.
- A Pressable **API application** (recommended). In MyPressable, open **API Applications** in the sidebar (under Account), create an application, and copy its **Client ID** and **Client Secret**. Give it read access to **Sites**, **FTP** and **Domains**, and edit access to **Sites** (for the Edge Cache fallback).
  - Without one, you can still link a site with the SSH details from its **SFTP | SSH Details** in MyPressable.
- The site's PHP file system permissions set to read-write (the default). A site set to read-only can be pulled but not pushed.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

This add-on is separate from ConnectLocal for Cloudways, Bluehost, Kinsta and Hostinger, and can be installed next to them: package names, IPC channels, CSS classes, storage folders and ignore files are all distinct.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. In MyPressable, add Local's SSH key under **your profile → Settings → SSH Keys** (the panel shows the key and a Copy button).
2. Open a site in Local and go to **Tools → Pressable**. Connect in one of two ways:
   - **Pressable API (recommended):** paste the Client ID and Client Secret, pick a site (live and staging sites are listed separately) and click **Link**. Sites that can't be linked, such as disabled ones, are shown greyed out with the reason. The add-on then:
     - reads the site's SSH user and domains from the API;
     - logs in to `ssh.pressable.com` with Local's SSH key, or with the SSH password if you typed one;
     - checks that WordPress is in Pressable's webroot, `/srv/htdocs`.
   - **SFTP/SSH details:** enter the SSH username from the site's **SFTP | SSH Details** in MyPressable. The host (`ssh.pressable.com`) and port (22) are filled in. Use Local's key, or the SSH password (Reset shows a new one, which also changes the SFTP password).
3. Push or pull from the panel's **Push to Pressable** / **Pull from Pressable** tabs. Once the site is linked, you can also use the **Pressable: Pull / Push** buttons in the site header.
   - Push options: Files and/or Database; delete files in `wp-content` on Pressable that aren't in Local (on by default, like WP Engine); clear Pressable's caches afterwards.
   - Pull options: Files and/or Database; back up the Local database first; delete Local files in `wp-content` that aren't on Pressable (on by default).
   - Every pull moves the Local files it replaces or deletes into `app/pressable-backups/pull-<time>/` instead of discarding them. The last 3 are kept.

Once a site is linked, a small Pressable logo appears next to its name in Local's sites list, and **Tools → Pressable** shows a green check. Other ConnectLocal add-ons put their logos in the same spot, so a site linked to more than one host shows each logo side by side.

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### Only `wp-content` moves

On Pressable, the webroot (`/srv/htdocs`) holds just `wp-config.php`, `wp-content`, and links into the platform's WordPress core (`__wp__` and `wp-load.php`). Pressable keeps core up to date itself. So the add-on transfers `wp-content` only:

- a push never sends Local's WordPress core or `wp-config.php`, and never deletes Pressable's core links, even with "delete files" on;
- a pull never replaces or deletes Local's own core or `wp-config.php`.

Because each side keeps its own core, a pull warns when Pressable runs a newer WordPress than the Local site. Update Local's WordPress to match.

### Plugins Pressable links in

Jetpack, Akismet and Pressable's OnePress Login plugin are links into the platform's own folder, as are the `object-cache.php` and `advanced-cache.php` drop-ins. The add-on finds these links when it connects:

- a **push** never replaces or deletes them;
- a **pull** brings the plugins down as real files, so they keep working in Local. Pressable's Jetpack build is large (about 320 MB), so the first pull takes longer; later pulls only move what changed.
- The caching drop-ins never move in either direction.

### Pull a Pressable site into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from Pressable**.
2. Pick the site, or enter SFTP/SSH details. Name the Local site; it defaults to the Pressable site's name.
3. Click **Create site & pull**. The connection is checked **first**, so a wrong login never leaves an empty site behind.

### Compare & sync files (selective sync)

Go to **Tools → Pressable → Compare & sync files** and click **Compare with Pressable**. Nothing changes until you choose files. Differing files in `wp-content` are listed under **Different on each side**, **Only in Local** and **Only on Pressable**. Tick files, then click **Push selected** or **Pull selected**. A ticked file that exists only on the receiving side is deleted there, except behind a link Pressable manages. The database is never touched.

### What a database push does

1. Exports the Local database and rewrites MySQL 8 `utf8mb4_0900_*` collations to ones MariaDB accepts.
2. On Pressable, saves the current database to `local-backup-before-push.sql` in a private folder, `~/.pressable-connect/site-<checksum>` in the site's SSH home (mode 700, outside the webroot). It also reads the current `home` URL and `table_prefix`.
3. Uploads the dump to that folder, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
4. Sets `table_prefix` in Pressable's `wp-config.php` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (`--precise`, `guid` skipped) from `//site.local` to the Pressable URL, including the JSON-escaped form, plus `http://` → `https://`.

### What a database pull does

1. On Pressable, exports the database with `--single-transaction` (the live site isn't locked), downloads it and deletes the export.
2. Makes the dump importable by Local's MySQL. It removes MariaDB's "sandbox mode" line and rewrites `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Imports through Local's own WP-CLI service. If the import fails, it restores the backup.
5. Matches Local's `table_prefix` to Pressable's, then replaces the Pressable URL, the site's other domains and the `www`/non-`www` twin with the Local URL.

### Backups

The add-on doesn't make a Pressable backup before a push. Pressable keeps daily backups of every site; restore one from the site's **Backups** tab in MyPressable. (Pressable's on-demand backups are limited to three of each kind per site, so the add-on leaves them for you to use.) On top of that, every database push keeps the previous database as `local-backup-before-push.sql` in the site's private folder (see above), and every pull keeps the Local files it replaced.

### Caches

After a push (option on by default), the add-on runs `wp cache flush` (the object cache) and `wp edge-cache purge` (Pressable's Edge Cache) over SSH. If the Edge Cache purge fails and the site was linked through the API, it purges it with `DELETE /v1/sites/{id}/edge-cache` instead. A failed purge is reported as a warning; the push itself has already succeeded.

### What is never transferred

Everything outside `wp-content` (see above). Inside it, these are excluded in both directions, and excluded paths are also protected from `--delete`:

- Pressable's caching drop-ins: `wp-content/object-cache.php`, `wp-content/advanced-cache.php`, and `wp-content/cache/`
- Server-specific state: `wp-content/jetpack-waf/`, `wp-content/upgrade/`, `wp-content/upgrade-temp-backup/`
- Migration-plugin backups: `wp-content/ai1wm-backups/`, `wp-content/updraft/`
- VCS and tool binaries, stray dumps, Local's helper files

Must-use plugins that exist only on the receiving side are never deleted.

To skip more, add rsync patterns (one per line) to `app/public/.pressable-push-ignore` or `.pressable-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

## Security notes

- **Secrets:** the API Client Secret and any typed SSH password are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). They are stored in `<Local data>/pressable-connect/settings.json` and never sent to the renderer. Access tokens (valid for an hour) are kept in memory only. A password goes to `ssh` through `SSH_ASKPASS` and an environment variable, never in argv or on disk.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/pressable-connect/ssh/`, separate from Local's WP Engine key and from the other ConnectLocal add-ons' keys. It also keeps its own `known_hosts` file, which pins the server's host key on first connect.
- **What the add-on changes on Pressable:**
  - the site's `wp-content` and database, when you push;
  - a private `~/.pressable-connect/site-<checksum>` folder in the site's SSH home, for dumps and the database backup;
  - `table_prefix` in `wp-config.php`, only when a push brings a different one;
  - Pressable's caches, when you push with the cache option on.
  It never adds SSH keys, resets passwords, or changes site settings; those stay in MyPressable.
- **Shared SSH connection:** on macOS and Linux, each push, pull or comparison logs in once and runs every command over that connection. Its control socket is `prc-<hash>` in a temporary folder only your user can use.

## Verified on a live account

On 2026-11-05, against a Pressable **Build** plan with one site (WordPress 7.1, PHP 8.4, MariaDB 11.8, WP-CLI 2.12, rsync 3.5.0):

- **API:** the token endpoint (client credentials, 1-hour tokens), `GET /v1/sites` (paginated), `GET /v1/sites/{id}`, `/ftp` (each user has `username`, `owner`, `email` and `sshKeyLabel`) and `/domains` respond as described above.
- **SSH:** `ssh.pressable.com` on port 22 with the site's SSH user and the add-on's key added in MyPressable. The home (`/home/<uid>`) holds `htdocs` (a link to `/srv/htdocs`) and the platform's `wordpress` folder. The database user has all privileges on the site's own database.
- **WP-CLI:** `wp` is a shell wrapper around WP-CLI 2.12; `proc_open` is available, so database commands run as is. `wp edge-cache purge` and `wp cache flush` work with plugins skipped.

The add-on itself was then run against that site, with Local's own rsync 3.1.3 and ssh and only Local's side (site data, database dump, WP-CLI) stubbed:

- **Link through the API:** found the site, picked the owner's SSH user from two (the other belongs to a collaborator), and linked with Local's key in about 4 seconds. It found the webroot, the private folder and the seven links into the platform.
- **Compare:** listed about 28,600 files, all inside `wp-content`.
- **Pull** (files and database): about 750 MB of `wp-content` (Jetpack alone is 315 MB) in a few minutes the first time, and the database (48 tables, 10 MB) in about 10 seconds. Local's core and `wp-config.php` were left alone, Pressable's core links and caching drop-ins didn't come down, and the MariaDB 11.8 dump came through with its collations rewritten.
- **Manual link** (username and Local's key, default host and port): found the same webroot and private folder.

A staging copy of that site, made with the API's clone endpoint, was then used for the push tests (the live site was left alone and checked afterwards):

- **Link a staging site:** listed under "Staging sites" and linked the same way. Right after cloning, Pressable refused the key for about a minute before accepting it.
- **Push** (files and database, deleting extra files on Pressable): about 17 seconds. The new site title was live on the next request (WordPress's REST index and `og:site_name`), no `//` Local URLs were left, a file that existed only on Pressable was deleted, and `wp-config.php`, the core links, the caching drop-ins and the Jetpack, Akismet and OnePress Login links were unchanged. The database backup was saved in the site's private folder, and `wp edge-cache purge` worked, so no API call was needed.
- **Compare and selective push:** no differences straight after the push; then a new Local file and a file only on Pressable were listed, the first pushed and the second deleted, and a checksum comparison afterwards (about 3 minutes for 28,600 files) found no differences.
- **Live site afterwards:** no trace of the staging URL, the Local URL or the test files.

## Limitations and what is not verified

- **Bare domains in text:** like Local Connect, a push or pull replaces `//domain` URLs (and their JSON-escaped form), not a domain written without `//`, such as `example.com/profile` in link text or an email address.

- **Not yet run inside Local itself.** Try the Tools panel, header buttons and "Pull from Pressable" wizard in a running Local before relying on them.
- **Password logins:** built the same way as in the other ConnectLocal add-ons, but no Pressable SSH password was used in testing.
- **Read-only file system:** a site whose PHP file system permissions are set to read-only hasn't been tried.
- **No pre-push backup:** rely on Pressable's daily backups and the database copy the add-on keeps.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password logins aren't supported (add Local's key in MyPressable), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the API client (client-credentials token, reuse and renewal, sites with pagination, SFTP users, domains, Edge Cache, errors and rate limiting);
  - the site choices and the linking flow (the owner's SSH user, key first, then the typed password, then a clear error), with the API faked;
  - the remote discovery script on a Pressable-like home: `~/htdocs` linking to the webroot outside the home, the private folder, and the links into the platform;
  - the `wp-content`-only scope, checked against a real rsync in both directions with `--delete`;
  - the cache purge over SSH with the API fallback;
  - dump normalization, URL replacement pairs, rsync itemize parsing and merging;
  - encrypted storage;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` and a Pressable-like site. Through Local's bundled `rsync`/`ssh`, it runs pushes, pulls, a comparison and selective syncs.

```
lib/
  main.js                 add-on main process: IPC handlers, account, site choices and linking flow
  main/PressableApi.js    Pressable API client (token, sites, SFTP users, domains, Edge Cache, object cache)
  main/SyncService.js     push and pull orchestration (discovery, files, database, search-replace, cache)
  main/transport.js       rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js          RSA key pair in OpenSSH format
  main/store.js           settings + encrypted secrets
  main/updater.js         checks GitHub releases and installs updates through Local's add-on installer
  renderer.js             hooks: Tools → Pressable tab, header pull/push buttons, create-site option, stylesheet
  renderer/components.js  React UI (plain React.createElement, no build step)
  renderer/siteMarks.js   logo marks in Local's sites list, shared with other ConnectLocal add-ons by DOM convention
```

### Sites-list marks (keep in sync across ConnectLocal add-ons)

Local has no hook for its sites list, so `renderer/siteMarks.js` adds the host's logo to each linked site's row
directly. Every ConnectLocal add-on carries its own copy of that file and follows the same convention, so their
logos share one strip per row instead of colliding:

- one `span[data-connectlocal-marks]` per row, right after the site name, created by whichever add-on needs it first
  and removed by whichever add-on empties it;
- one `span[data-connectlocal-host="<host>"]` per linked add-on inside it, in alphabetical order of the host key;
- inline styles only, so a mark never relies on another add-on's stylesheet.

A new host's add-on keeps `siteMarks.js` unchanged and only changes the `hostKey`, `label`, `color` and IPC channel
it passes in from `renderer.js`. If the convention itself changes, change it in every add-on.

### Pressable API endpoints used

| Purpose | Endpoint |
| --- | --- |
| Auth | `POST /auth/token` with `grant_type=client_credentials`, `client_id` and `client_secret`; then `Authorization: Bearer <token>`. Tokens last an hour and are renewed automatically. |
| Sites | `GET /v1/sites?paginate=true&page=&per_page=50`, `GET /v1/sites/{id}` |
| SSH user | `GET /v1/sites/{id}/ftp` |
| Domains | `GET /v1/sites/{id}/domains` (best effort) |
| Edge Cache | `DELETE /v1/sites/{id}/edge-cache` (only when `wp edge-cache purge` fails) |

The base URL is `https://my.pressable.com`.

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
