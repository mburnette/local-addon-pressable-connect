'use strict';

/**
 * End-to-end push and pull against a throwaway, unprivileged sshd on 127.0.0.1 that stands in for a Pressable site,
 * laid out as on a live one: the SSH user's home holds `htdocs`, a link to the webroot (srv/htdocs, outside the home),
 * and `wordpress`, the platform's folder. The webroot holds only the server's wp-config.php, wp-content and links into
 * the platform's core (`__wp__`, `wp-load.php`); the caching drop-ins, Jetpack and Akismet are links into the platform's
 * folder too. Pressable's `wp` is a bash wrapper and proc_open is available, so WP-CLI runs as plain `wp`: a fake bash
 * `wp` (with Pressable's `edge-cache purge` command) and a fake `php` on the remote PATH record every call, and a fake
 * Pressable API records Edge Cache purges, so the whole files + database pipeline runs through real ssh/rsync (Local's
 * bundled binaries when Local is installed) without touching a real host.
 *
 * Run: node --test test/e2e/localSshd.e2e.js   (macOS/Linux, needs /usr/sbin/sshd)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const LOCAL_RESOURCES = '/Applications/Local.app/Contents/Resources/extraResources';
if (fs.existsSync(LOCAL_RESOURCES)) {
	process.electronPaths = { resourcesPath: LOCAL_RESOURCES };
}

const { SyncService } = require('../../lib/main/SyncService');
const { SshKeyStore } = require('../../lib/main/sshKey');
const { findBundledBinDir } = require('../../lib/main/transport');

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));

/**
 * Pressable's wp is a bash wrapper around WP-CLI (not a PHP file), so the add-on runs it as is. This stand-in logs
 * every call as it was made, and emulates the handful of commands push and pull use, including `edge-cache purge`
 * (which fails while $FAKE_WP_STATE/edge-fail exists).
 */
const FAKE_WP = `#!/bin/bash
S="$FAKE_WP_STATE"
echo "wp $*" >> "$S/wp.log"
args=()
for a in "$@"; do case "$a" in --skip-plugins|--skip-themes) ;; *) args+=("$a") ;; esac; done
set -- "\${args[@]}"
case "$1 $2" in
  "config get") cat "$S/prefix" ;;
  "config set") printf '%s' "$4" > "$S/prefix" ;;
  "db query") if [ "$3" = "SHOW TABLES" ]; then p="$(cat "$S/prefix")"; printf '%soptions\\n%sposts\\n' "$p" "$p"; fi ;;
  "option get") echo "https://shop.example.com" ;;
  "core version") echo "6.8.3" ;;
  "db export") echo "$*" >> "$S/exports.log"
    case "$3" in
      *local-pull-*) printf '%s\\n' '/*M!999999\\- enable the sandbox mode */' \\
        'CREATE TABLE \`wp_options\` (x int) COLLATE=utf8mb4_uca1400_ai_ci;' \\
        "INSERT INTO \\\`wp_options\\\` VALUES ('siteurl','https://shop.example.com');" > "$3" ;;
      *) echo "-- remote backup" > "$3" ;;
    esac ;;
  "db reset") : ;;
  "db import") cp "$3" "$S/imported.sql" ;;
  "cache flush") : ;;
  "edge-cache purge") [ -e "$S/edge-fail" ] && { echo "Error: edge cache unavailable" >&2; exit 1; }; echo purged >> "$S/edge.log" ;;
  *) : ;;
esac
exit 0
`;

/** php with proc_open available; logs calls so the test can show WP-CLI never runs through it. */
const FAKE_PHP = `#!/bin/sh
echo "php $*" >> "$FAKE_WP_STATE/php.log"
if [ "$1" = "-r" ]; then printf yes; exit 0; fi
exit 1
`;

const isLink = (p) => {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch (e) {
		return false;
	}
};

const write = (file, body, mode) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(file, mode);
};

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitForPort(port, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(true); }).on('error', () => resolve(false));
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`sshd did not start on ${port}`);
}

test('pushes to and pulls from a stand-in Pressable site over ssh/rsync', { skip: !SSHD || process.platform === 'win32', timeout: 120000 }, async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-e2e-')));
	const dirs = Object.fromEntries(['sshd', 'state', 'bin', 'work', 'local'].map((d) => [d, path.join(root, d)]));
	Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	// ---------------------------------------------------------------- "Local" site
	const webRoot = path.join(dirs.local, 'app', 'public');
	write(path.join(webRoot, 'wp-config.php'), '<?php // LOCAL creds');
	write(path.join(webRoot, 'index.php'), '<?php // local index');
	write(path.join(webRoot, 'local-notes.txt'), 'outside wp-content, never synced');
	// Local's own WordPress core: never pushed, and a pull checks for it before touching the database.
	['wp-load.php', 'wp-settings.php', 'wp-includes/version.php', 'wp-admin/index.php'].forEach((f) => write(path.join(webRoot, f), '<?php // local core'));
	write(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme */');
	write(path.join(webRoot, 'wp-content', 'private-mode.php'), '<?php // 600 locally', 0o600);
	write(path.join(webRoot, 'wp-content', 'object-cache.php'), '<?php // local cache dropin');
	// Local has Jetpack as real files; on Pressable it is a link into the platform's folder that a push must not replace.
	write(path.join(webRoot, 'wp-content', 'plugins', 'jetpack', 'jetpack.php'), '<?php // local jetpack');
	write(path.join(webRoot, '.pressable-push-ignore'), 'secret-notes.txt\n');
	write(path.join(webRoot, 'wp-content', 'secret-notes.txt'), 'do not push');
	// A child theme developed in another folder and symlinked into the site, plus a link whose target is gone.
	const devTheme = path.join(root, 'dev', 'mytheme');
	write(path.join(devTheme, 'style.css'), '/* Theme Name: Mine Child */');
	write(path.join(devTheme, 'assets', 'app.css'), 'body{color:#196cdf}');
	fs.symlinkSync(devTheme, path.join(webRoot, 'wp-content', 'themes', 'mine-child'));
	fs.symlinkSync(path.join(root, 'dev', 'deleted-plugin'), path.join(webRoot, 'wp-content', 'themes', 'gone'));

	// ---------------------------------------------------------------- "Pressable" site
	const home = path.join(root, 'home', '123456789');
	const platform = path.join(home, 'wordpress');
	const remoteWeb = path.join(root, 'srv', 'htdocs');
	const core = path.join(platform, 'core', 'latest');
	['wp-load.php', 'wp-settings.php', 'wp-includes/version.php', 'wp-admin/index.php'].forEach((f) => write(path.join(core, f), '<?php // pressable core'));
	write(path.join(platform, 'drop-ins', 'object-cache.php'), '<?php // pressable object cache');
	write(path.join(platform, 'drop-ins', 'advanced-cache.php'), '<?php // pressable page cache');
	const jetpack = path.join(platform, 'plugins', 'jetpack', 'latest');
	write(path.join(jetpack, 'jetpack.php'), '<?php // platform jetpack');
	write(path.join(jetpack, 'modules', 'stats.php'), '<?php // stats');
	const akismet = path.join(platform, 'plugins', 'akismet', 'latest');
	write(path.join(akismet, 'akismet.php'), '<?php // platform akismet');
	write(path.join(remoteWeb, 'wp-config.php'), '<?php // PRESSABLE creds');
	write(path.join(remoteWeb, 'google1234.html'), 'google-site-verification');
	fs.mkdirSync(path.join(remoteWeb, 'wp-content', 'plugins'), { recursive: true });
	fs.symlinkSync(core, path.join(remoteWeb, '__wp__'));
	fs.symlinkSync('__wp__/wp-load.php', path.join(remoteWeb, 'wp-load.php'));
	fs.symlinkSync(path.join(platform, 'drop-ins', 'object-cache.php'), path.join(remoteWeb, 'wp-content', 'object-cache.php'));
	fs.symlinkSync(path.join(platform, 'drop-ins', 'advanced-cache.php'), path.join(remoteWeb, 'wp-content', 'advanced-cache.php'));
	fs.symlinkSync(jetpack, path.join(remoteWeb, 'wp-content', 'plugins', 'jetpack'));
	fs.symlinkSync(akismet, path.join(remoteWeb, 'wp-content', 'plugins', 'akismet'));
	fs.symlinkSync(remoteWeb, path.join(home, 'htdocs'));
	write(path.join(remoteWeb, 'wp-content', 'mu-plugins', 'host-only.php'), '<?php // installed on the server');
	write(path.join(remoteWeb, 'wp-content', 'stale.php'), '<?php // stale');
	// An existing server file with its own permissions, which a push must not reset.
	write(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), '/* old remote theme */', 0o640);
	fs.writeFileSync(path.join(dirs.state, 'prefix'), 'wp_');
	const managedLinks = () => Object.fromEntries(['__wp__', 'wp-load.php', 'wp-content/object-cache.php', 'wp-content/advanced-cache.php', 'wp-content/plugins/jetpack', 'wp-content/plugins/akismet']
		.map((p) => [p, isLink(path.join(remoteWeb, p)) ? fs.readlinkSync(path.join(remoteWeb, p)) : null]));
	const managedBefore = managedLinks();
	const platformFiles = () => execFileSync('find', [platform, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
		.map((f) => [path.relative(platform, f), fs.readFileSync(f, 'utf8')]);
	const platformBefore = platformFiles();

	fs.writeFileSync(path.join(dirs.bin, 'wp'), FAKE_WP, { mode: 0o755 });
	fs.writeFileSync(path.join(dirs.bin, 'php'), FAKE_PHP, { mode: 0o755 });

	// Key the user added in MyPressable → your profile → Settings → SSH Keys
	const keys = new SshKeyStore(path.join(dirs.work, 'ssh'));
	fs.writeFileSync(path.join(dirs.sshd, 'authorized_keys'), `${keys.ensure('e2e')}\n`, { mode: 0o600 });

	const port = await freePort();
	const hostKey = path.join(dirs.sshd, 'host_ed25519');
	execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
	const remotePath = [dirs.bin, findBundledBinDir(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
	fs.writeFileSync(path.join(dirs.sshd, 'sshd_config'), [
		`Port ${port}`,
		'ListenAddress 127.0.0.1',
		`HostKey ${hostKey}`,
		`PidFile ${path.join(dirs.sshd, 'sshd.pid')}`,
		`AuthorizedKeysFile ${path.join(dirs.sshd, 'authorized_keys')}`,
		'PasswordAuthentication no',
		'KbdInteractiveAuthentication no',
		'UsePAM no',
		'StrictModes no',
		`SetEnv PATH=${remotePath} FAKE_WP_STATE=${dirs.state} HOME=${home}`,
		'',
	].join('\n'));
	const sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dirs.sshd, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
	let sshdLog = '';
	sshd.stderr.on('data', (d) => { sshdLog += d; });
	t.after(() => sshd.kill());
	await waitForPort(port);

	const events = [];
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(dirs.local, 'app', 'sql') } };
	const localWpCalls = [];
	// Linked through the Pressable API: no remote path yet, so discovery starts from the webRoot hint.
	const link = {
		mode: 'account',
		platform: 'pressable',
		host: '127.0.0.1',
		port,
		username: os.userInfo().username,
		authType: 'key',
		pressableSiteId: '1234567',
		domain: 'shop.example.com',
		directory: '',
		webRoot: remoteWeb,
		label: 'Shop',
		altDomains: ['www.shop.example.com'],
		excludeDirs: [],
	};
	let storedLink = { ...link };
	const apiCalls = [];
	const fakeApi = {
		purgeEdgeCache: async (siteId) => { apiCalls.push(['purgeEdgeCache', siteId]); },
	};
	const service = new SyncService({
		store: {
			getLink: () => storedLink,
			updateLink: (id, patch) => { storedLink = { ...storedLink, ...patch }; },
		},
		keys,
		workDir: dirs.work,
		getApi: () => fakeApi,
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, [
					'CREATE TABLE `wp_options` (x int) COLLATE=utf8mb4_0900_ai_ci;',
					"INSERT INTO `wp_options` VALUES ('siteurl','http://shop.local');",
				].join('\n')),
				getTablePrefix: async () => 'wplocal_',
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			// Stand-in for Local's WpCliService.run(site, args)
			wpCli: {
				run: async (_site, args) => {
					localWpCalls.push(args.join(' '));
					if (args.join(' ') === 'option get home') return 'http://shop.local\n';
					if (args.join(' ') === 'core version') return '6.8.2\n';
					if (args[0] === 'db' && args[1] === 'import') fs.copyFileSync(args[2], path.join(dirs.state, 'local-imported.sql'));
					return '';
				},
			},
		},
		sendIPCEvent: (...args) => events.push(args),
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	const run = async (promise) => {
		try {
			return await promise;
		} catch (e) {
			return assert.fail(`${e.message}\n--- sshd ---\n${sshdLog}`);
		}
	};
	const wpLog = () => fs.readFileSync(path.join(dirs.state, 'wp.log'), 'utf8').trim().split('\n');
	const exportsLog = () => fs.readFileSync(path.join(dirs.state, 'exports.log'), 'utf8').trim().split('\n');
	const remoteRootEntries = ['__wp__', 'google1234.html', 'wp-config.php', 'wp-content', 'wp-load.php'];

	// ---------------------------------------------------------------- push
	let result = await run(service.push('site1'));
	assert.equal(result.ok, true);
	assert.deepEqual(result.warnings, []);
	// The whole push (discovery, rsync, a dozen WP-CLI calls) uses one SSH connection.
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((sshdLog.match(/Accepted publickey/g) || []).length, 1, sshdLog);

	// Discovery: the hinted webroot (outside the home), its server-managed links, no nested sites.
	assert.equal(storedLink.remotePath, remoteWeb);
	assert.deepEqual(storedLink.managed, ['__wp__', 'wp-content/advanced-cache.php', 'wp-content/object-cache.php', 'wp-content/plugins/akismet', 'wp-content/plugins/jetpack', 'wp-load.php']);
	assert.deepEqual(storedLink.nested, []);

	// Only wp-content moved: Local's core, index.php, wp-config.php and root files stay home; the server's own
	// wp-config.php, core links and root files survive --delete.
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries, 'nothing is pushed to, or deleted from, the webroot outside wp-content');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // PRESSABLE creds');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'google1234.html'), 'utf8'), 'google-site-verification');
	assert.deepEqual(managedLinks(), managedBefore, 'core, drop-in, Jetpack and Akismet links are never replaced or deleted');
	assert.deepEqual(platformFiles(), platformBefore, 'nothing is written into the platform\'s folder through a link');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-load.php'), 'utf8'), '<?php // pressable core');
	// wp-content: pushed, excludes respected, remote-only must-use plugins kept, stale files deleted
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), 'utf8'), '/* theme */');
	assert.ok(fs.existsSync(path.join(remoteWeb, 'wp-content', 'mu-plugins', 'host-only.php')), 'remote-only must-use plugins are never deleted');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'stale.php')), 'stale remote file should be deleted');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'secret-notes.txt')), '.pressable-push-ignore should apply');
	// No --perms: updated files keep the server's mode; new files get the --chmod defaults.
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css')).mode & 0o777, 0o640);
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'private-mode.php')).mode & 0o777, 0o644);
	// A theme symlinked from outside the site arrives as real files; a broken link is skipped, not fatal.
	const remoteChild = path.join(remoteWeb, 'wp-content', 'themes', 'mine-child');
	assert.ok(!isLink(remoteChild), 'linked theme must be copied, not sent as a dangling link');
	assert.equal(fs.readFileSync(path.join(remoteChild, 'assets', 'app.css'), 'utf8'), 'body{color:#196cdf}');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'themes', 'gone')) && !isLink(path.join(remoteWeb, 'wp-content', 'themes', 'gone')));

	// Database: backup in a private folder in the home (named by a checksum, since the webroot is outside the home),
	// only this site's tables, collations rewritten, temp dump cleaned up.
	const cksum = execFileSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d " " -f 1', 'sh', remoteWeb], { encoding: 'utf8' }).trim();
	const privateDir = path.join(home, '.pressable-connect', `site-${cksum}`);
	assert.equal(storedLink.privateDir, privateDir);
	assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.dirname(privateDir)).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(home).sort(), ['.pressable-connect', 'htdocs', 'wordpress'], 'nothing else is written in the home');
	assert.deepEqual(fs.readdirSync(privateDir), ['local-backup-before-push.sql'], 'temporary dumps are removed');
	assert.match(exportsLog()[0], new RegExp(`^db export ${privateDir}/local-backup-before-push\\.sql --tables=wp_options,wp_posts --no-tablespaces=true$`));
	const imported = fs.readFileSync(path.join(dirs.state, 'imported.sql'), 'utf8');
	assert.ok(imported.includes('utf8mb4_unicode_520_ci') && !imported.includes('0900'));

	const pushWp = wpLog();
	// Pressable's wp is a bash wrapper: run as plain `wp`, never through php, always without plugins and themes.
	assert.ok(pushWp.every((l) => l.startsWith('wp --skip-plugins --skip-themes ')), pushWp.join('\n'));
	const phpLog = fs.existsSync(path.join(dirs.state, 'php.log')) ? fs.readFileSync(path.join(dirs.state, 'php.log'), 'utf8').trim().split('\n') : [];
	assert.ok(phpLog.every((l) => l.startsWith('php -r')), `only the proc_open check uses php:\n${phpLog.join('\n')}`);
	const wpArgs = pushWp.map((l) => l.slice('wp --skip-plugins --skip-themes '.length));
	assert.ok(wpArgs.includes('db reset --yes'));
	assert.ok(wpArgs.some((a) => a.startsWith(`db import ${privateDir}/local-push-`)));
	assert.ok(wpArgs.includes('config set table_prefix wplocal_'));
	assert.equal(fs.readFileSync(path.join(dirs.state, 'prefix'), 'utf8'), 'wplocal_');
	assert.ok(wpArgs.includes('search-replace //shop.local //shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(wpArgs.includes('search-replace \\/\\/shop.local \\/\\/shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(wpArgs.includes('search-replace http://shop.example.com https://shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	// Caches last: the object cache, then Pressable's Edge Cache through its own WP-CLI command; the API is not needed.
	assert.deepEqual(wpArgs.slice(-2), ['cache flush', 'edge-cache purge']);
	assert.equal(fs.readFileSync(path.join(dirs.state, 'edge.log'), 'utf8'), 'purged\n');
	assert.deepEqual(apiCalls, []);

	// Site overlay lifecycle mirrors Local Connect
	const statuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , s]) => s);
	assert.equal(statuses[0], 'pushing_v2');
	assert.equal(statuses[statuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'pressable-site-pushed' && banner.variant === 'success'));

	// ---------------------------------------------------------------- push when WP-CLI can't purge the Edge Cache
	fs.writeFileSync(path.join(dirs.state, 'edge-fail'), '');
	result = await run(service.push('site1', { database: false }));
	fs.rmSync(path.join(dirs.state, 'edge-fail'));
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(apiCalls, [['purgeEdgeCache', '1234567']], 'the API purges it for the linked Pressable site');
	assert.deepEqual(wpLog().slice(-2).map((l) => l.split(' ').slice(3).join(' ')), ['cache flush', 'edge-cache purge']);
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries);
	assert.deepEqual(managedLinks(), managedBefore);

	// ---------------------------------------------------------------- pull
	write(path.join(remoteWeb, 'wp-content', 'uploads', 'photo.jpg'), 'jpeg');
	write(path.join(webRoot, 'wp-content', 'local-only.php'), '<?php // only in local');
	write(path.join(remoteChild, 'server-edit.css'), '/* edited on the server */');
	fs.writeFileSync(path.join(dirs.state, 'exports.log'), '');
	events.length = 0;

	result = await run(service.pull('site1'));
	assert.equal(result.ok, true);
	// Each side keeps its own core, so the database may come from a newer WordPress.
	assert.deepEqual(result.warnings, ['Pressable runs WordPress 6.8.3 and this Local site has 6.8.2; update Local\'s WordPress to match.']);

	// Files: remote uploads arrive; Local keeps its own core, wp-config.php, root files and cache drop-in.
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'uploads', 'photo.jpg'), 'utf8'), 'jpeg');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-config.php'), 'utf8'), '<?php // LOCAL creds');
	['wp-load.php', 'wp-settings.php', 'wp-includes/version.php', 'wp-admin/index.php'].forEach((f) => {
		assert.ok(!isLink(path.join(webRoot, f)), f);
		assert.equal(fs.readFileSync(path.join(webRoot, f), 'utf8'), '<?php // local core', `${f}: a pull never replaces Local's core`);
	});
	assert.equal(fs.readFileSync(path.join(webRoot, 'index.php'), 'utf8'), '<?php // local index');
	assert.equal(fs.readFileSync(path.join(webRoot, 'local-notes.txt'), 'utf8'), 'outside wp-content, never synced');
	assert.ok(!fs.existsSync(path.join(webRoot, '__wp__')) && !isLink(path.join(webRoot, '__wp__')), 'Pressable\'s core link never lands in Local');
	assert.ok(!fs.existsSync(path.join(webRoot, 'google1234.html')), 'root files on the server stay there');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'object-cache.php'), 'utf8'), '<?php // local cache dropin');
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'advanced-cache.php')), 'Pressable\'s page cache drop-in stays on the server');
	// Jetpack and Akismet (links into the platform's folder) arrive as real files.
	const localJetpack = path.join(webRoot, 'wp-content', 'plugins', 'jetpack');
	assert.ok(!isLink(localJetpack) && fs.statSync(localJetpack).isDirectory());
	assert.equal(fs.readFileSync(path.join(localJetpack, 'jetpack.php'), 'utf8'), '<?php // platform jetpack');
	assert.equal(fs.readFileSync(path.join(localJetpack, 'modules', 'stats.php'), 'utf8'), '<?php // stats');
	const localAkismet = path.join(webRoot, 'wp-content', 'plugins', 'akismet');
	assert.ok(!isLink(localAkismet));
	assert.equal(fs.readFileSync(path.join(localAkismet, 'akismet.php'), 'utf8'), '<?php // platform akismet');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'mu-plugins', 'host-only.php'), 'utf8'), '<?php // installed on the server');
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'local-only.php')), 'local-only file should be deleted');
	// Nothing a pull replaces or deletes is lost: it is moved to app/pressable-backups/pull-<time>/.
	const backupsDir = path.join(dirs.local, 'app', 'pressable-backups');
	const latestBackup = () => path.join(backupsDir, fs.readdirSync(backupsDir).sort().pop());
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-content', 'local-only.php'), 'utf8'), '<?php // only in local');
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-content', 'plugins', 'jetpack', 'jetpack.php'), 'utf8'), '<?php // local jetpack');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && /were saved in app\/pressable-backups\/pull-/.test(banner.message)));
	// The linked theme is Local-owned: the link stays, and nothing is written into or deleted from its real folder.
	assert.ok(isLink(path.join(webRoot, 'wp-content', 'themes', 'mine-child')));
	assert.deepEqual(fs.readdirSync(devTheme).sort(), ['assets', 'style.css']);
	assert.ok(isLink(path.join(webRoot, 'wp-content', 'themes', 'gone')), 'broken link left alone');
	fs.rmSync(path.join(remoteChild, 'server-edit.css'));
	// The pull changed nothing on the server.
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries);
	assert.deepEqual(managedLinks(), managedBefore);
	assert.deepEqual(platformFiles(), platformBefore);

	// Database: only this site's tables exported, Local backed up first, MariaDB dump normalized for MySQL, URLs rewritten.
	assert.match(exportsLog()[0], new RegExp(`^db export ${privateDir}/local-pull-[0-9a-f]+\\.sql --tables=wplocal_options,wplocal_posts --no-tablespaces=true --single-transaction --quick --lock-tables=false$`));
	assert.ok(fs.existsSync(path.join(dirs.local, 'app', 'sql', 'local-backup-before-pull.sql')));
	const pulledSql = fs.readFileSync(path.join(dirs.state, 'local-imported.sql'), 'utf8');
	assert.ok(!pulledSql.includes('sandbox mode') && !pulledSql.includes('uca1400'));
	assert.ok(pulledSql.includes("'siteurl','https://shop.example.com'"));
	assert.deepEqual(localWpCalls.slice(0, 3), ['core version', 'option get home', 'db reset --yes']);
	assert.match(localWpCalls[3], /^db import .+pressable-pull-site1-[0-9a-f]+\.sql$/);
	const sr = (from, to) => `search-replace ${from} ${to} --all-tables --precise --skip-columns=guid --report-changed-only`;
	assert.deepEqual(localWpCalls.filter((c) => c.startsWith('search-replace ')), [
		sr('//shop.example.com', '//shop.local'),
		sr('\\/\\/shop.example.com', '\\/\\/shop.local'),
		sr('//www.shop.example.com', '//shop.local'),
		sr('\\/\\/www.shop.example.com', '\\/\\/shop.local'),
		sr('https://shop.local', 'http://shop.local'),
	]);
	assert.ok(!localWpCalls.some((c) => c.startsWith('config set')), 'prefixes already match after the push');
	assert.deepEqual(fs.readdirSync(privateDir), ['local-backup-before-push.sql'], 'remote export cleaned up');

	const pullStatuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , st]) => st);
	assert.equal(pullStatuses[0], 'pulling');
	assert.equal(pullStatuses[pullStatuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'pressable-site-pulled' && banner.variant === 'warning'));
	assert.ok(events.some(([name]) => name === 'refreshSiteVersions'));
	assert.ok(storedLink.lastPull && storedLink.lastPush);

	// ---------------------------------------------------------------- compare & selective sync
	const later = new Date(Date.now() + 120000);
	write(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme v2, edited locally */');
	fs.utimesSync(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), later, later);
	write(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php'), '<?php // new plugin');
	write(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg'), 'jpeg2');
	// Pressable updates Jetpack in its own folder: the comparison sees the new file through the link.
	write(path.join(jetpack, 'modules', 'new-module.php'), '<?php // new module');
	// Files outside wp-content never appear in a comparison, on either side.
	write(path.join(webRoot, 'wp-settings.php'), '<?php // local core, edited');
	write(path.join(remoteWeb, 'robots.txt'), 'User-agent: *');

	let comparison = await run(service.compare('site1'));
	const summary = (c) => c.entries.map((e) => [e.path, e.status, e.newer]);
	assert.deepEqual(summary(comparison), [
		['wp-content/plugins/jetpack/modules/new-module.php', 'remote-only', null],
		['wp-content/plugins/p/new.php', 'local-only', null],
		['wp-content/themes/mine/style.css', 'changed', 'local'],
		['wp-content/uploads/remote only.jpg', 'remote-only', null],
	], 'excluded files (core, wp-config.php, object-cache.php, ignore-listed) never appear');
	const styleEntry = comparison.entries[2];
	assert.equal(styleEntry.local.size, '/* theme v2, edited locally */'.length);
	assert.equal(styleEntry.remote.size, '/* theme */'.length);

	await assert.rejects(service.push('site1', { fileList: ['wp-config.php'] }), /out of date/);
	comparison = await run(service.compare('site1'));

	// Push three: the edited stylesheet goes up, the remote-only upload is deleted on the server, and the file behind
	// Pressable's Jetpack link is left alone (deleting it would delete it in the platform's folder).
	result = await run(service.push('site1', {
		fileList: ['wp-content/themes/mine/style.css', 'wp-content/uploads/remote only.jpg', 'wp-content/plugins/jetpack/modules/new-module.php'],
	}));
	assert.match(result.warnings.join(' '), /^1 selected file\(s\) behind a link Pressable manages, or in another site's folder, were not deleted on Pressable\.$/);
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), 'utf8'), '/* theme v2, edited locally */');
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css')).mode & 0o777, 0o640);
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg')));
	assert.ok(fs.existsSync(path.join(jetpack, 'modules', 'new-module.php')), 'the platform\'s Jetpack keeps its file');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'plugins', 'p', 'new.php')), 'unselected file stays put');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // PRESSABLE creds');
	assert.deepEqual(managedLinks(), managedBefore);
	assert.equal(storedLink.lastPush.selectedFiles, 3);

	comparison = await run(service.compare('site1'));
	assert.deepEqual(summary(comparison), [
		['wp-content/plugins/jetpack/modules/new-module.php', 'remote-only', null],
		['wp-content/plugins/p/new.php', 'local-only', null],
	]);

	// Pull the remaining two: the new Jetpack module arrives as a real file in Local's real Jetpack folder, and the
	// plugin that does not exist on Pressable is removed locally (and kept in the pull backup).
	await run(service.pull('site1', { fileList: ['wp-content/plugins/jetpack/modules/new-module.php', 'wp-content/plugins/p/new.php'] }));
	assert.ok(!isLink(localJetpack) && !isLink(path.join(localJetpack, 'modules')));
	assert.equal(fs.readFileSync(path.join(localJetpack, 'modules', 'new-module.php'), 'utf8'), '<?php // new module');
	assert.equal(fs.readFileSync(path.join(localJetpack, 'jetpack.php'), 'utf8'), '<?php // platform jetpack');
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php')));
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-content', 'plugins', 'p', 'new.php'), 'utf8'), '<?php // new plugin');
	assert.ok(fs.readdirSync(backupsDir).length <= 3, 'only the last 3 pull backups are kept');
	assert.deepEqual((await run(service.compare('site1'))).entries, []);

	// Checksum mode catches same-size, same-mtime edits that the quick check cannot see
	const remoteStyle = path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css');
	const stamp = fs.statSync(remoteStyle).mtime;
	fs.writeFileSync(remoteStyle, '/* theme v2, edited remotely */'.slice(0, '/* theme v2, edited locally */'.length));
	fs.utimesSync(remoteStyle, stamp, stamp);
	assert.deepEqual((await run(service.compare('site1'))).entries, []);
	assert.deepEqual(summary(await run(service.compare('site1', { checksum: true }))), [['wp-content/themes/mine/style.css', 'changed', 'same']]);

	// Nothing outside wp-content moved in any of the above, on either side.
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), [...remoteRootEntries, 'robots.txt'].sort());
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-settings.php'), 'utf8'), '<?php // local core, edited');
	assert.ok(!fs.existsSync(path.join(webRoot, 'robots.txt')));

	// A pull into a Local site whose core is gone stops before the database is touched.
	fs.rmSync(path.join(webRoot, 'wp-settings.php'));
	await assert.rejects(service.pull('site1', { files: false }), /WordPress core is missing.*database was not changed/);
});
