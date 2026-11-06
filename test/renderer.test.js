'use strict';

/**
 * Mounts the renderer half in jsdom with the real @getflywheel/local-components and React 16 (the version Local
 * ships), stubbing only Electron and Local's renderer API. Catches bad imports/props before Local ever loads it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="popup-container"></div></body></html>', {
	pretendToBeVisual: true,
});
// React's scheduler keeps a MessageChannel port open, and jsdom an animation-frame timer (pretendToBeVisual); both
// would keep the test process alive after the last test, so they are closed once the tests are done.
const channels = [];
global.MessageChannel = class TrackedMessageChannel extends MessageChannel {
	constructor() {
		super();
		channels.push(this);
	}
};
test.after(() => {
	channels.forEach((channel) => {
		channel.port1.close();
		channel.port2.close();
	});
	dom.window.close();
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// Remaining DOM constructors (HTMLCollection, NodeList, …) that react-modal and friends expect as globals.
Object.getOwnPropertyNames(dom.window)
	.filter((key) => /^[A-Z]/.test(key) && !(key in global))
	.forEach((key) => { global[key] = dom.window[key]; });

const { IPC } = require('../lib/constants');

let mainState;
let linkedSites = {};
let compareResult;
let siteChoices;
let listError = null;
let testRemote = null;
const ipcCalls = [];
const listeners = {};

/** Site choices as main's toSiteChoices builds them: live sites first, then staging sites. */
const choice = (id, displayName, domain, extra = {}) => ({
	id, name: displayName.toLowerCase().replace(/\W+/g, '-'), displayName, domain, url: `https://${domain}/`, staging: false, sandbox: false,
	state: 'live', linkable: true, reason: null, group: 'Live sites', ...extra,
});
const SHOP = choice('101', 'Shop', 'shop.example.com');
const DEFAULT_CHOICES = [
	choice('103', 'Broken', 'broken.example.com', { state: 'disabled', linkable: false, reason: 'disabled' }),
	SHOP,
	choice('105', 'shop2.example.com', 'shop2.example.com'),
	choice('102', 'Shop staging', 'shop-staging.mystagingwebsite.com', { staging: true, group: 'Staging sites' }),
];

const stubs = {
	electron: {
		ipcRenderer: {
			on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
			removeListener: (ch, fn) => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); },
		},
		shell: { openExternal() {} },
	},
	'@getflywheel/local/renderer': {
		ipcAsync: async (channel, ...args) => {
			ipcCalls.push([channel, ...args]);
			if (channel === IPC.GET_STATE) return mainState;
			if (channel === IPC.LINKED_SITES) return linkedSites;
			if (channel === IPC.LIST_SITES) {
				if (listError) throw listError;
				return siteChoices || DEFAULT_CHOICES;
			}
			if (channel === IPC.TEST_CONNECTION) return testRemote;
			if (channel === IPC.GET_PUBLIC_KEY) return 'ssh-rsa AAAAB3Nza test';
			if (channel === IPC.COMPARE) return compareResult;
			if (channel === IPC.NEW_SITE_LOCATION) return { domain: `${args[0].toLowerCase()}.local`, sitePath: `~/Local Sites/${args[0].toLowerCase()}` };
			if (channel === IPC.PULL_NEW_SITE) return { domain: 'shop.local', sitePath: '~/Local Sites/shop' };
			return null;
		},
		confirm: async () => true,
	},
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
	return originalLoad.call(this, request, ...rest);
};

const React = require('react');
const ReactDOM = require('react-dom');
const { act } = require('react-dom/test-utils');

const registered = { content: {}, filters: {} };
const hooks = {
	addContent: (name, cb) => { (registered.content[name] = registered.content[name] || []).push(cb); },
	addFilter: (name, cb) => { (registered.filters[name] = registered.filters[name] || []).push(cb); },
};
require('../lib/renderer')({ React, ReactRouter: require('react-router-dom'), hooks });

const site = { id: 'site1', name: 'Shop Local', domain: 'shop.local' };

async function mount(element) {
	const root = document.getElementById('root');
	await act(async () => {
		ReactDOM.render(element, root);
	});
	// let ipcAsync promises and effects settle
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	return root;
}

async function click(el) {
	await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text && b.getAttribute('role') !== 'tab');
const tab = (root, text) => [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === text);

function toolsPanel() {
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	assert.equal(items.length, 1);
	return items[0].render();
}

/** Broadcasts a state change, as main does after linking/unlinking, and lets the marks catch up. */
async function stateChanged(newLinked) {
	linkedSites = newLinked;
	await act(async () => {
		(listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null));
		await new Promise((r) => setTimeout(r, 20));
	});
}

test.after(() => dom.window.close());

test.afterEach(async () => {
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });
	document.getElementById('popup-container').innerHTML = '';
	siteChoices = null;
});

test('registers stylesheet, tools tab, header, create-site option and route hooks', () => {
	assert.equal(registered.content.stylesheets.length, 1);
	const options = registered.filters['CreateSite:RadioOptions'][0]({ 'add-site': { label: 'Create a new site' } });
	assert.deepEqual(Object.keys(options), ['add-site', 'pressable-pull']);
	assert.equal(options['pressable-pull'].label, 'Pull from Pressable');
	const route = registered.content['routes[main]'][0]({});
	assert.equal(route.props.path, '/main/pressable-pull');
	assert.equal(registered.filters.siteInfoToolsItem.length, 1);
	assert.equal(registered.content.SiteInfo_Top_TopRight.length, 1);
	const link = registered.content.stylesheets[0]();
	assert.match(link.props.href, /lib\/renderer\/styles\.css$/);
});

const typeInto = async (input, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const fieldInput = (root, label) => [...root.querySelectorAll('.PRConnect_Field')]
	.find((f) => f.querySelector('.PRConnect_FieldLabel').textContent === label)
	.querySelector('input');

const fieldNamed = (root, label) => [...root.querySelectorAll('.PRConnect_Field')]
	.find((f) => f.querySelector('.PRConnect_FieldLabel').textContent === label);
const selectValue = async (select, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
	select.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const LINKED_SHOP = {
	mode: 'account', platform: 'pressable', authType: 'password', label: 'Shop', domain: 'shop.example.com', directory: '',
	pressableSiteId: '101', siteName: 'shop', staging: false, host: 'ssh.pressable.com', port: 22, username: 'f00dfeed12345678a',
	remotePath: '/srv/htdocs', nested: [], excludeDirs: [], altDomains: [], managed: ['__wp__', 'wp-load.php'],
};
const ACCOUNT = { connectedAt: '2026-11-05T00:00:00Z', sites: 4, email: 'owner@example.com', name: 'Owner' };

test('asks for a Pressable API application when no account is connected', async () => {
	mainState = { account: null, link: null, publicKey: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.ok(tab(root, 'Pressable API'));
	assert.ok(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /In MyPressable, open API Applications in the sidebar \(under Account\), create an application/);
	assert.match(root.textContent, /read access to Sites, FTP and Domains, and edit access to Sites/);
	assert.doesNotMatch(root.textContent, /hPanel|API token/);
	assert.equal(fieldInput(root, 'Client Secret').type, 'password', 'the secret is masked');
	assert.equal(button(root, 'Connect account').getAttribute('aria-disabled'), 'true', 'both fields are needed');

	await typeInto(fieldInput(root, 'Client ID'), 'client-id');
	await typeInto(fieldInput(root, 'Client Secret'), 'client-secret');
	ipcCalls.length = 0;
	await click(button(root, 'Connect account'));
	assert.deepEqual(ipcCalls.find(([ch]) => ch === IPC.CONNECT_ACCOUNT)[1], { clientId: 'client-id', clientSecret: 'client-secret' });
});

test('lists live and staging sites, disables unlinkable ones and links the chosen one', async () => {
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /Connected to owner@example\.com · 4 sites/);
	assert.deepEqual([...root.querySelectorAll('select optgroup')].map((g) => g.label), ['Live sites', 'Staging sites']);
	const options = [...root.querySelectorAll('select option')];
	assert.deepEqual(options.map((o) => o.textContent), [
		'Broken — broken.example.com (disabled)',
		'Shop — shop.example.com',
		'shop2.example.com',
		'Shop staging — shop-staging.mystagingwebsite.com',
	]);
	assert.ok(options[0].disabled, 'an unlinkable site cannot be picked');
	assert.ok(options.slice(1).every((o) => !o.disabled));
	assert.equal(root.querySelector('select').value, SHOP.id, 'the first linkable site is preselected');
	assert.equal(root.querySelector('textarea').value, 'ssh-rsa AAAAB3Nza test', 'shows Local\'s key to add in MyPressable');
	assert.match(fieldNamed(root, 'Local\'s SSH key').textContent, /MyPressable → your profile → Settings → SSH Keys/);
	assert.match(fieldNamed(root, 'SSH password (optional)').textContent, /SFTP \| SSH Details/);
	assert.equal(fieldInput(root, 'SSH password (optional)').type, 'password');

	// Without a typed password only the choice's id goes to main, which reads the site again itself.
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(sent, { siteId: 'site1', id: SHOP.id });
	assert.match(progressId, /^link-/);

	// A staging site with a typed SSH password.
	await selectValue(root.querySelector('select'), '102');
	await typeInto(fieldInput(root, 'SSH password (optional)'), 'ssh-pw');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId: _id, ...second } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(second, { siteId: 'site1', id: '102', password: 'ssh-pw' });
});

test('explains why a site cannot be linked and hides the password field where it is unsupported', async () => {
	siteChoices = [DEFAULT_CHOICES[0]];
	mainState = { account: { ...ACCOUNT, sites: 1 }, link: null, passwordAuthSupported: false };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /owner@example\.com · 1 site(?!s)/);
	assert.match(root.textContent, /This site can't be linked: disabled\./);
	assert.equal(button(root, 'Link Shop Local').getAttribute('aria-disabled'), 'true');
	assert.equal(fieldNamed(root, 'SSH password (optional)'), undefined, 'Windows logs in with the key only');
});

test('says so when the application sees no sites', async () => {
	siteChoices = [];
	mainState = { account: { ...ACCOUNT, sites: 0 }, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /No sites were found for this API application/);
	assert.equal(root.querySelector('select'), null);
});

test('a failed site listing shows the error and can be retried, without a spinner that never stops', async () => {
	listError = new Error('Pressable no longer accepts this API application.');
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	try {
		const root = await mount(toolsPanel());
		assert.match(root.querySelector('[role="alert"]').textContent, /no longer accepts this API application/);
		assert.doesNotMatch(root.textContent, /Loading your Pressable sites/);
		listError = null;
		await click(button(root, 'Refresh list'));
		assert.equal(root.querySelectorAll('select option').length, DEFAULT_CHOICES.length);
		assert.equal(root.querySelector('[role="alert"]'), null);
	} finally {
		listError = null;
	}
});

test('SFTP/SSH tab takes the login from the site\'s SFTP | SSH Details, with Pressable\'s gateway by default', async () => {
	mainState = { account: null, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	await click(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /Sites → your site → SFTP \| SSH Details/);
	assert.equal(fieldInput(root, 'SSH host').value, 'ssh.pressable.com');
	assert.equal(fieldInput(root, 'Port').value, '22');
	assert.equal(fieldInput(root, 'Remote path (optional)').placeholder, '/srv/htdocs');
	assert.ok(fieldNamed(root, 'Public key'), 'Local\'s key is the default');
	await typeInto(fieldInput(root, 'Username'), 'a1b2c3d4e5f6a7b8c');
	await click(root.querySelectorAll('.PRConnect_AuthChoice input')[0]);
	await typeInto(fieldInput(root, 'Password'), 'pw');
	await typeInto(fieldInput(root, 'Site domain (optional)'), 'example.com');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_MANUAL)[1];
	assert.deepEqual(sent, {
		siteId: 'site1', host: 'ssh.pressable.com', port: '22', username: 'a1b2c3d4e5f6a7b8c', authType: 'password', password: 'pw', remotePath: '', domain: 'example.com',
	});
});

test('linked site shows the site, its SSH login and webroot, and pushes with the chosen options', async () => {
	mainState = { account: null, passwordAuthSupported: true, link: LINKED_SHOP };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /SiteShop/);
	assert.match(root.textContent, /Domainshop\.example\.com/);
	assert.match(root.textContent, /Pressable siteshop(?! \(staging\))/);
	assert.match(root.textContent, /SSH loginf00dfeed12345678a@ssh\.pressable\.com(?!:)/, 'port 22 is not spelled out');
	assert.match(root.textContent, /Remote path\/srv\/htdocs/);
	assert.doesNotMatch(root.textContent, /Never synced/);
	assert.match(root.textContent, /SSH password \(stored encrypted\)\. Add Local's SSH key in MyPressable → your profile → Settings → SSH Keys/);
	assert.match(root.textContent, /Files \(wp-content: plugins, themes and uploads\)/);
	assert.match(root.textContent, /Clear Pressable caches afterwards \(object cache and Edge Cache\)/);
	assert.doesNotMatch(root.textContent, /hPanel|LiteSpeed/);

	const pushButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Push to Pressable' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pushButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.ok(push, 'push IPC should be sent');
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { files: true, database: true, deleteRemote: true, purgeCache: true },
	});
});

test('a staging link says so, a manual link has no Pressable site row, and Test connection is accurate about WP-CLI', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key', staging: true, siteName: 'shop-staging', label: 'Shop staging' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /Pressable siteshop-staging \(staging\)/);
	assert.match(root.textContent, /AuthenticationLocal's SSH key/);
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });

	mainState = { account: null, link: { mode: 'manual', platform: null, authType: 'key', host: 'ssh.pressable.com', port: 22, username: 'abc', remotePath: '/srv/htdocs', domain: 'example.com', label: 'example.com' } };
	root = await mount(toolsPanel());
	assert.doesNotMatch(root.textContent, /Pressable site/);
	assert.doesNotMatch(root.textContent, /Domain/, 'the domain is already the label');

	testRemote = { remotePath: '/srv/htdocs', hasWpCli: false, hasPhp: true };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /WP-CLI missing: the first database push or pull installs it/);
	testRemote = { remotePath: '/srv/htdocs', hasWpCli: true, hasPhp: true };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /Connected\. WordPress found at \/srv\/htdocs\./);
	testRemote = null;
});

test('pull tab sends a pull with its own options', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key' } };
	const root = await mount(toolsPanel());
	const pullTab = [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'Pull from Pressable');
	await act(async () => { pullTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(root.textContent, /Local keeps its own WordPress core/);
	assert.match(root.textContent, /Back up the Local database first/);
	assert.match(root.textContent, /Delete Local files that are not on Pressable/);
	assert.doesNotMatch(root.textContent, /Clear Pressable caches|Pressable backup/);

	const pullButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pull from Pressable' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pullButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const pull = ipcCalls.find(([ch]) => ch === IPC.PULL);
	assert.ok(pull, 'pull IPC should be sent');
	assert.deepEqual(pull[1], { siteId: 'site1', options: { files: true, database: true, backupLocal: true, deleteLocal: true } });
});

test('header buttons only appear for linked sites and open push/pull modals', async () => {
	mainState = { account: null, link: null };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	assert.equal(root.textContent, '');

	// Linking elsewhere (e.g. in the Tools tab) broadcasts a state change; the header picks it up.
	mainState = { account: null, link: { mode: 'manual', authType: 'password', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	await act(async () => {
		listeners[IPC.STATE_CHANGED].forEach((fn) => fn({}, 'site1'));
		await new Promise((r) => setTimeout(r, 10));
	});
	const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
	assert.deepEqual(labels, ['Pull', 'Push']);

	await act(async () => { root.querySelectorAll('button')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(document.body.textContent, /This overwrites the files and database of Shop Local in Local with shop\.example\.com/);
});

test('push modal spells out what changes on Pressable, what never does, and how to roll back', async () => {
	mainState = { account: null, link: LINKED_SHOP };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	await act(async () => { root.querySelectorAll('button')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	const text = document.body.textContent;
	assert.match(text, /This overwrites the files and database on Shop with Shop Local from Local\. Visitors see the change right away\./);
	assert.match(text, /private \.pressable-connect folder in the site's SSH home folder/);
	assert.match(text, /WordPress core, wp-config\.php and the plugins and drop-ins Pressable manages \(Jetpack, Akismet, the caching drop-ins\) are never touched/);
	assert.match(text, /restore one of Pressable's daily backups in MyPressable/);
	assert.doesNotMatch(text, /hPanel/);
});

test('header shows progress and disables both buttons while a pull runs', async () => {
	mainState = { account: null, activity: 'pull', link: { mode: 'manual', authType: 'key', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'pulling'));
	const buttons = [...root.querySelectorAll('button')];
	assert.deepEqual(buttons.map((b) => b.textContent), ['Pulling…', 'Push']);
	// Local's buttons mark disabled state with aria-disabled and swallow clicks.
	assert.ok(buttons.every((b) => b.getAttribute('aria-disabled') === 'true'));
	await act(async () => { buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.doesNotMatch(document.body.textContent, /This overwrites/, 'no modal while a transfer is running');
});

test('compare view groups differences and syncs only the selected files', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key' } };
	compareResult = {
		at: '2026-10-30T00:00:00Z',
		checksum: false,
		entries: [
			{ path: 'wp-content/themes/shop/style.css', type: 'file', status: 'changed', local: { size: 2048, mtime: 1790000000 }, remote: { size: 1900, mtime: 1780000000 }, newer: 'local' },
			{ path: 'wp-content/plugins/new/new.php', type: 'file', status: 'local-only', local: { size: 10, mtime: 1790000000 }, remote: null, newer: null },
			{ path: 'wp-content/uploads/2026/10/photo.jpg', type: 'file', status: 'remote-only', local: null, remote: { size: 3 * 1024 * 1024, mtime: 1790000000 }, newer: null },
		],
	};
	const root = await mount(toolsPanel());
	await click(tab(root, 'Compare & sync files'));
	ipcCalls.length = 0;
	await click(button(root, 'Compare with Pressable'));
	assert.deepEqual(ipcCalls[0], [IPC.COMPARE, { siteId: 'site1', checksum: false }]);
	assert.match(root.textContent, /1 different on each side · 1 only in local · 1 only on pressable/);
	assert.match(root.textContent, /Newer in Local/);
	assert.match(root.textContent, /3\.0 MB/);

	// Filter narrows the list
	const filter = root.querySelector('.PRConnect_Filter input');
	await typeInto(filter, 'themes');
	assert.equal(root.querySelectorAll('.PRConnect_FileRow').length, 1);
	await typeInto(filter, '');

	// Select the changed theme file and the remote-only upload, then push them
	const rows = [...root.querySelectorAll('.PRConnect_FileRow input')];
	await click(rows[0]);
	await click(rows[2]);
	assert.match(root.textContent, /2 selected/);
	ipcCalls.length = 0;
	await click(button(root, 'Push selected'));
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { fileList: ['wp-content/themes/shop/style.css', 'wp-content/uploads/2026/10/photo.jpg'], purgeCache: true },
	});
	assert.ok(ipcCalls.some(([ch]) => ch === IPC.COMPARE), 'compares again after syncing');
});

test('create-site page pulls a Pressable site into a new Local site', async () => {
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	const history = { pushed: [], push(p) { this.pushed.push(p); } };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history }));
	await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

	assert.match(root.textContent, /Pull from Pressable/);
	assert.match(root.textContent, /pulls the wp-content files and database of a Pressable site/);
	const nameInput = root.querySelector('input');
	assert.equal(nameInput.value, 'Shop', 'defaults to the selected site\'s name');
	assert.match(root.textContent, /shop\.local · ~\/Local Sites\/shop/);

	ipcCalls.length = 0;
	await click(button(root, 'Create site & pull'));
	const { siteName, source } = ipcCalls.find(([ch]) => ch === IPC.PULL_NEW_SITE)[1];
	const { progressId, ...rest } = source;
	assert.equal(siteName, 'Shop');
	assert.deepEqual(rest, { kind: 'account', id: SHOP.id });
	assert.match(progressId, /^link-/, 'lets the main process stream progress back to this form');
	assert.match(root.textContent, /Creating Shop at shop\.local/);

	await click(button(root, '← Back'));
	assert.deepEqual(history.pushed, ['/main/create-site']);
});

test('create-site page names the Local site after the domain when the site has no display name', async () => {
	siteChoices = [{ ...SHOP, displayName: '' }];
	mainState = { account: { ...ACCOUNT, sites: 1 }, link: null, passwordAuthSupported: true };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history: { push() {} } }));
	assert.equal(root.querySelector('input').value, 'shop.example.com');
	assert.equal(root.querySelector('select option').textContent, 'shop.example.com');
});

test('brand: Pressable orange icon tile, add-on card colour and stylesheet accent', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const rootDir = path.join(__dirname, '..');
	const icon = fs.readFileSync(path.join(rootDir, 'icon.svg'), 'utf8');
	assert.match(icon, /<path fill="#dd3a03" d="M69\.3\.9H4\.9/, 'Pressable\'s mark, from the official logo');
	assert.match(icon, /<rect x="14" y="10\.6" width="40\.6" height="49\.5" fill="#fff"\/>/, 'the white P');
	assert.equal(require('../package.json').bgColor, '#dd3a03');
	const css = fs.readFileSync(path.join(rootDir, 'lib', 'renderer', 'styles.css'), 'utf8');
	assert.match(css, /--pr-accent: #dd3a03;/);
	assert.doesNotMatch(css, /#673de6|#ff492c|103, 61, 230|purple/i, 'no leftover accent from the previous brand');
});

test('shows an available update and installs it through the main process', async () => {
	const update = { name: 'ConnectLocal for Pressable', current: '0.1.0', latest: '0.2.0', releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0', devInstall: false, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update };
	ipcCalls.length = 0;
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Pressable 0\.2\.0 is available\. You have 0\.1\.0\./);
	await click(button(root, 'Update'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.INSTALL_UPDATE));

	mainState = { ...mainState, update: { ...update, installed: true } };
	await act(async () => { (listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	assert.match(root.textContent, /0\.2\.0 is installed\. Restart Local/);
	await click(button(root, 'Restart Local'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.RESTART_LOCAL));
});

test('a development copy shows the update but no Update button, and the footer can check manually', async () => {
	const update = { name: 'ConnectLocal for Pressable', current: '0.1.0', latest: null, releaseUrl: null, devInstall: true, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update: { ...update, latest: '0.2.0' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /linked from a development folder/);
	assert.equal(button(root, 'Update'), undefined);
	await act(async () => { ReactDOM.unmountComponentAtNode(root); });

	mainState = { ...mainState, update };
	ipcCalls.length = 0;
	root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Pressable 0\.1\.0/);
	await click(button(root, 'Check for updates'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.CHECK_UPDATE));
	assert.match(root.textContent, /You have the latest version\./);
});

test('tools tab entry shows a check only while the site is linked', async () => {
	await stateChanged({});
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	const root = await mount(items[0].menuItem);
	assert.equal(root.textContent, 'Pressable');
	assert.ok(!root.querySelector('.PRConnect_LinkedCheck'));
	await stateChanged({ site1: 'shop.example.com' });
	assert.ok(root.querySelector('.PRConnect_LinkedCheck'), 'check appears once linked');
	await stateChanged({});
	assert.ok(!root.querySelector('.PRConnect_LinkedCheck'), 'check goes away on unlink');
});

test('sites list gets a logo mark that shares one strip with other ConnectLocal add-ons', async () => {
	const sidebar = document.createElement('nav');
	sidebar.innerHTML = ['site1', 'site2'].map((id) => `<a class="TID_SiteListSite" data-site-id="${id}">`
		+ `<span class="icon"></span><span class="TID_SiteListSite_Span_SiteName">${id}</span><time>Oct 27</time></a>`).join('');
	document.body.appendChild(sidebar);
	const row = (id) => sidebar.querySelector(`[data-site-id="${id}"]`);
	const hosts = (id) => [...row(id).querySelectorAll('[data-connectlocal-host]')].map((m) => m.getAttribute('data-connectlocal-host'));
	try {
		// Another add-on (Kinsta) already marked site1; ours must join its strip in alphabetical order (after it).
		const strip = document.createElement('span');
		strip.setAttribute('data-connectlocal-marks', '');
		const kinsta = document.createElement('span');
		kinsta.setAttribute('data-connectlocal-host', 'kinsta');
		strip.appendChild(kinsta);
		row('site1').insertBefore(strip, row('site1').querySelector('time'));

		await stateChanged({ site1: 'shop.example.com', site2: null });
		assert.deepEqual(hosts('site1'), ['kinsta', 'pressable']);
		assert.deepEqual(hosts('site2'), ['pressable']);
		assert.equal(row('site1').querySelectorAll('[data-connectlocal-marks]').length, 1, 'one strip per row');
		const mark = row('site1').querySelector('[data-connectlocal-host="pressable"]');
		assert.equal(mark.title, 'Linked to Pressable (shop.example.com)');
		assert.match(mark.style.backgroundImage, /data:image\/svg\+xml/);
		// Strip sits right after the site name, before Local's own extras.
		assert.equal(row('site2').querySelector('.TID_SiteListSite_Span_SiteName').nextSibling.hasAttribute('data-connectlocal-marks'), true);

		// Rows Local renders later are picked up by the observer.
		sidebar.insertAdjacentHTML('beforeend', '<a class="TID_SiteListSite" data-site-id="site3"><span class="TID_SiteListSite_Span_SiteName">site3</span></a>');
		await stateChanged({ site1: 'shop.example.com', site2: null, site3: null });
		assert.deepEqual(hosts('site3'), ['pressable']);

		// Unlinking removes only our mark; an emptied strip goes too.
		await stateChanged({});
		assert.deepEqual(hosts('site1'), ['kinsta']);
		assert.equal(row('site2').querySelector('[data-connectlocal-marks]'), null);
	} finally {
		sidebar.remove();
	}
});
