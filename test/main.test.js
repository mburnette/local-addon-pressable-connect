'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. The Pressable API is
 * a fake global fetch answering with the shapes seen on a live account (2026-11-05); SSH is stubbed at
 * SyncService.transportFor (a fake transport) and at SyncService.discoverRemote / pull.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService } = require('../lib/main/SyncService');
const { TransportError } = require('../lib/main/transport');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

const REMOTE = {
	remotePath: '/srv/htdocs',
	privateDir: '/home/123456789/.pressable-connect/site-123',
	wp: 'wp',
	hasWpCli: true,
	hasRsync: true,
	hasPhp: true,
	nested: [],
	managed: ['__wp__', 'wp-load.php', 'wp-content/plugins/jetpack'],
};

const OWNER_EMAIL = 'owner@example.com';
const site = (id, extra = {}) => ({
	id,
	accountId: 42,
	clonedFromId: null,
	datacenterCode: 'DFW',
	displayName: `site${id}.example`,
	name: `site${id}`,
	url: `site${id}.example`,
	staging: false,
	sandbox: false,
	state: 'live',
	sftpDomain: 'sftp.pressable.com',
	phpVersion: '8.4',
	wpEnvironmentType: 'production',
	phpFsPermission: 'rw',
	...extra,
});
const SHOP = 101;
const SITES = [
	site(SHOP, { displayName: 'Shop', name: 'shop', url: 'shop.example' }),
	site(102, { displayName: 'Shop staging', name: 'shop-staging', url: 'shop-staging.mystagingwebsite.com', staging: true, clonedFromId: SHOP }),
	site(103, { displayName: 'Broken', state: 'disabled' }),
	site(104, { displayName: 'New', state: 'creating' }),
];
const SFTP = {
	[SHOP]: [
		{ id: 1, username: 'r2e72be283a8bf8ad', owner: false, email: 'collab@example.com', sshKeyLabel: null },
		{ id: 2, username: 'f00dfeed12345678a', owner: true, email: 'Owner@Example.com', sshKeyLabel: 'Local' },
	],
	102: [{ id: 3, username: 'stg0000000000001', owner: true, email: OWNER_EMAIL }],
};
const DOMAINS = {
	[SHOP]: [
		{ id: 1, primary: true, domainName: 'shop.example', type: 'ARecord' },
		{ id: 2, primary: false, domainName: 'www.shop.example', type: 'ARecord' },
		{ id: 3, primary: false, domainName: 'old-shop.example', type: 'ARecord' },
	],
};

/** Fake Pressable API. The `api` flags steer it; every request is recorded in `calls`. */
const api = {};
const resetApi = () => Object.assign(api, { tokens: 0, domainsStatus: 200, expireNext: false });
resetApi();
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => null } });
globalThis.fetch = async (url, init) => {
	const u = new URL(url);
	const key = `${init.method} ${u.pathname}`;
	calls.push(['api', key, u.search]);
	if (key === 'POST /auth/token') {
		const form = new URLSearchParams(init.body);
		if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== 'good-id' || form.get('client_secret') !== 'good-secret') {
			return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
		}
		api.tokens += 1;
		return json(200, { access_token: `token-${api.tokens}`, token_type: 'Bearer', expires_in: 3600, name: 'Owner', email: OWNER_EMAIL, scopes: ['authorized'] });
	}
	if (!/^Bearer token-\d+$/.test(init.headers.Authorization || '')) return json(401, { message: 'Unauthorized', data: null, errors: ['Invalid token'] });
	if (api.expireNext) {
		api.expireNext = false;
		return json(401, { message: 'Unauthorized', data: null, errors: ['Token expired'] });
	}
	const ok = (data, extra = {}) => json(200, { message: 'Success', data, errors: null, ...extra });
	if (key === 'GET /v1/sites') {
		const page = Number(u.searchParams.get('page')) || 1;
		const perPage = Number(u.searchParams.get('per_page')) || 20;
		const last = Math.max(1, Math.ceil(SITES.length / perPage));
		return ok(SITES.slice((page - 1) * perPage, page * perPage), { page: { currentPage: page, lastPage: last, perPage, totalItems: SITES.length } });
	}
	let m = /^GET \/v1\/sites\/(\d+)$/.exec(key);
	if (m) {
		const found = SITES.find((x) => String(x.id) === m[1]);
		return found ? ok(found) : json(404, { message: 'Not Found', data: null, errors: ['Site not found'] });
	}
	m = /^GET \/v1\/sites\/(\d+)\/ftp$/.exec(key);
	if (m) return ok(SFTP[m[1]] || []);
	m = /^GET \/v1\/sites\/(\d+)\/domains$/.exec(key);
	if (m) return api.domainsStatus === 200 ? ok(DOMAINS[m[1]] || []) : json(api.domainsStatus, { message: 'Error', data: null, errors: ['Boom'] });
	return json(404, { message: 'Not Found', data: null, errors: ['No route'] });
};

/** How SSH logins go: (transport) -> true to accept, or a TransportError to throw. */
let acceptLogin;

SyncService.prototype.transportFor = function transportFor(link) {
	return {
		username: link.username,
		host: link.host,
		port: link.port,
		password: link.authType === 'password' ? link.password : null,
		close: async () => {},
		exec: async () => ({ code: 0, stdout: '', stderr: '' }),
	};
};
let discoverBehaviour = async () => REMOTE;
SyncService.prototype.discoverRemote = async function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, transport.port, transport.password, hints]);
	const outcome = acceptLogin(transport);
	if (outcome instanceof Error) throw outcome;
	if (!outcome) {
		throw new TransportError(`Pressable refused the ${transport.password ? 'password' : 'SSH key'} for ${transport.username}@${transport.host}`, 255, 'Permission denied (publickey,password).');
	}
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);
const apiCalls = () => calls.filter((c) => c[0] === 'api').map((c) => c[1]);
const discovers = () => calls.filter((c) => c[0] === 'discover').map((c) => c.slice(1));
const settingsFile = () => fs.readFileSync(path.join(userDataPath, 'pressable-connect', 'settings.json'), 'utf8');
const reset = () => {
	calls.length = 0;
	resetApi();
	acceptLogin = () => true;
	discoverBehaviour = async () => REMOTE;
};

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('rejected API credentials are reported and nothing is stored', async () => {
	reset();
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ clientId: 'good-id', clientSecret: 'bad' }), /rejected this Client ID and Client Secret/);
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ clientId: '', clientSecret: 'x' }), /Paste the Client ID and Client Secret/);
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
});

test('connecting validates the application, counts the sites and keeps the secret out of the renderer', async () => {
	reset();
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ clientId: ' good-id\n', clientSecret: ' good-\u200bsecret ' });
	assert.deepEqual(Object.keys(state.account).sort(), ['connectedAt', 'email', 'name', 'sites']);
	assert.equal(state.account.sites, SITES.length);
	assert.equal(state.account.email, OWNER_EMAIL);
	assert.ok(!settingsFile().includes('good-secret'), 'the secret is stored encrypted');
	assert.ok(!JSON.stringify(state).includes('good-secret') && !JSON.stringify(state).includes('good-id'));
	assert.deepEqual(apiCalls(), ['POST /auth/token', 'GET /v1/sites']);
});

test('lists live sites first, then staging sites; disabled and unfinished ones cannot be linked', async () => {
	reset();
	const choices = await handlers[IPC.LIST_SITES]();
	assert.deepEqual(choices.map((c) => [c.id, c.group, c.domain, c.linkable, c.reason]), [
		['103', 'Live sites', 'site103.example', false, 'disabled'],
		['104', 'Live sites', 'site104.example', false, 'creating'],
		['101', 'Live sites', 'shop.example', true, null],
		['102', 'Staging sites', 'shop-staging.mystagingwebsite.com', true, null],
	]);
	assert.equal(apiCalls().filter((c) => c === 'POST /auth/token').length, 0, 'the token from connecting is reused');
});

test('links a site with Local\'s SSH key as the owner\'s SSH user, on ssh.pressable.com:22 in /srv/htdocs', async () => {
	reset();
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', id: String(SHOP), progressId: 'p1' });
	const { link } = state;
	assert.equal(link.mode, 'account');
	assert.equal(link.host, 'ssh.pressable.com');
	assert.equal(link.port, 22);
	assert.equal(link.username, 'f00dfeed12345678a', 'the application owner\'s user (email matched case-insensitively), not the collaborator\'s');
	assert.equal(link.pressableSiteId, '101');
	assert.equal(link.domain, 'shop.example');
	assert.equal(link.label, 'Shop');
	assert.equal(link.authType, 'key');
	assert.deepEqual(link.altDomains, ['www.shop.example', 'old-shop.example']);
	assert.equal(link.remotePath, '/srv/htdocs');
	assert.deepEqual(link.managed, REMOTE.managed);
	const [d] = discovers();
	assert.deepEqual(d.slice(0, 4), ['f00dfeed12345678a', 'ssh.pressable.com', 22, null]);
	assert.equal(d[4].remotePath, '/srv/htdocs', 'only Pressable\'s webroot is searched');
	assert.deepEqual(apiCalls(), ['GET /v1/sites/101', 'GET /v1/sites/101/ftp', 'GET /v1/sites/101/domains']);
	assert.ok(calls.some((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS && c[2] === 'p1'));
});

test('a staging site links like any other and says so', async () => {
	reset();
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 's1', id: '102' });
	assert.equal(link.staging, true);
	assert.equal(link.username, 'stg0000000000001');
	assert.equal(link.domain, 'shop-staging.mystagingwebsite.com', 'without a domain list, the site URL is the domain');
	assert.deepEqual(link.altDomains, ['www.shop-staging.mystagingwebsite.com']);
});

test('a failed domain listing does not stop linking', async () => {
	reset();
	api.domainsStatus = 500;
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 's2', id: String(SHOP) });
	assert.equal(link.domain, 'shop.example');
	assert.deepEqual(link.altDomains, ['www.shop.example']);
});

test('renews an expired token once and carries on', async () => {
	reset();
	api.expireNext = true;
	const choices = await handlers[IPC.LIST_SITES]();
	assert.equal(choices.length, SITES.length);
	assert.deepEqual(apiCalls(), ['GET /v1/sites', 'POST /auth/token', 'GET /v1/sites']);
});

test('disabled, unknown and malformed site ids are not linked', async () => {
	reset();
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '103' }), /can't be linked \(disabled\)/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '999' }), /could not be found/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '../101' }), /Choose a Pressable site/);
	assert.ok(!names().includes('discover'));
});

test('uses the typed SSH password when Pressable refuses Local\'s key, and stores it encrypted', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a4', id: String(SHOP), password: 'typed-ssh-pw' });
	assert.deepEqual(discovers().map((d) => d[3]), [null, 'typed-ssh-pw']);
	assert.equal(state.link.authType, 'password');
	assert.equal(state.link.hasPassword, true);
	assert.ok(!settingsFile().includes('typed-ssh-pw'));

	// Later connections reuse the stored password and the stored hints.
	calls.length = 0;
	await handlers[IPC.TEST_CONNECTION]('a4');
	const [d] = discovers();
	assert.equal(d[3], 'typed-ssh-pw');
	assert.deepEqual(d[4], { remotePath: '/srv/htdocs', webRoot: '/srv/htdocs', excludeDirs: [] });
	assert.ok(!apiCalls().length, 'testing a link needs no API calls');
});

test('explains where to add Local\'s key when it is refused and no password was typed', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP) }),
		/refused Local's SSH key for f00dfeed12345678a\. Add Local's public key .* in MyPressable → your profile → Settings → SSH Keys, then link again\. A site created or a key added in the last few minutes can take a minute or two.*Or type the site's SSH password/,
	);
	assert.equal(discovers().length, 1);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('on Windows a refused key is not followed by advice to type a password it has no field for', async () => {
	reset();
	acceptLogin = () => false;
	const platform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	try {
		assert.equal((await handlers[IPC.GET_STATE]()).passwordAuthSupported, false);
		const err = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP) }).then(() => null, (e) => e);
		assert.match(err.message, /password authentication is not supported on Windows yet\. Add Local's public key/);
		assert.doesNotMatch(err.message, /type the site's SSH password/);
	} finally {
		Object.defineProperty(process, 'platform', platform);
	}
	assert.equal(discovers().length, 1);
});

test('explains what to check when both the key and the typed password are refused', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP), password: 'wrong' }),
		/refused both Local's SSH key and the SSH password.*SFTP \| SSH Details/,
	);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('an unreachable server is reported as is, and not retried with the password', async () => {
	reset();
	acceptLogin = (t) => new TransportError(`Could not reach ${t.username}@${t.host}:${t.port}: Connection timed out.`, 255, 'ssh: connect to host ssh.pressable.com port 22: Connection timed out');
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP), password: 'pw' }), /Connection timed out/);
	assert.equal(discovers().length, 1);
});

test('links with SSH details from MyPressable, defaulting to ssh.pressable.com:22', async () => {
	reset();
	const state = await handlers[IPC.LINK_MANUAL]({ siteId: 'm1', host: '', port: '', username: 'abc123def456', authType: 'key', domain: 'https://Manual.example/' });
	const { link } = state;
	assert.equal(link.mode, 'manual');
	assert.equal(link.host, 'ssh.pressable.com');
	assert.equal(link.port, 22);
	assert.equal(link.domain, 'manual.example');
	assert.deepEqual(link.altDomains, ['www.manual.example']);
	const [d] = discovers();
	assert.deepEqual(d[4], { remotePath: null, webRoot: '/srv/htdocs', excludeDirs: [] });
	assert.ok(!apiCalls().length, 'a manual link needs no API');

	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: 'ssh.pressable.com', username: '-oProxyCommand=x', authType: 'key' }), /Enter the SSH username/);
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: '-bad', username: 'abc', authType: 'key' }), /Enter the SSH host/);
});

test('picks the SSH user by the application owner\'s email, then the site owner, then the only user', () => {
	const { pickSftpUser } = addonMain;
	const users = [
		{ username: 'collab1', owner: false, email: 'a@example.com' },
		{ username: 'owner1', owner: true, email: 'b@example.com' },
	];
	assert.equal(pickSftpUser(users, 'A@example.com').username, 'collab1');
	assert.equal(pickSftpUser(users, 'nobody@example.com').username, 'owner1');
	assert.equal(pickSftpUser([{ username: 'solo', owner: false }], null).username, 'solo');
	assert.equal(pickSftpUser([{ username: 'x', owner: false }, { username: 'y', owner: false }], null), null);
	assert.equal(pickSftpUser([{ username: '-oBad', owner: true }], null), null);
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'account', id: String(SHOP), password: 'typed-ssh-pw', progressId: 'p9' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.ok(names().includes('discover') && names().indexOf('discover') < names().indexOf('addSite'), 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));
	assert.ok(calls.some((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS && c[2] === 'p9'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.label, 'Shop');
	assert.equal(state.link.authType, 'password');
});

test('pull to new site creates nothing when the connection fails', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: 'ssh.pressable.com', port: '22', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
});

test('disconnecting forgets the application; listing then asks to connect again', async () => {
	reset();
	await handlers[IPC.DISCONNECT_ACCOUNT]();
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
	assert.equal(JSON.parse(settingsFile()).account, null);
	await assert.rejects(handlers[IPC.LIST_SITES](), /Connect your Pressable account first/);
	// Links keep working without the account: they log in over SSH only.
	await handlers[IPC.TEST_CONNECTION]('a4');
	await handlers[IPC.CONNECT_ACCOUNT]({ clientId: 'good-id', clientSecret: 'good-secret' });
});
