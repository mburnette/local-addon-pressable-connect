'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PressableApi, errorMessageFrom } = require('../lib/main/PressableApi');

const quiet = { info() {}, warn() {}, error() {} };

/** A fetch stand-in that answers from `routes` ({ 'METHOD /path': (url, init) => [status, body, headers?] }) and records calls. */
function fakeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const u = new URL(url);
		const key = `${init.method} ${u.pathname}`;
		calls.push({ key, url: u, init });
		const route = routes[key];
		const [status, body, headers = {}] = route ? route(u, init, calls) : [404, { message: 'Not Found', data: null, errors: ['No route'] }];
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body),
			headers: { get: (name) => headers[name.toLowerCase()] || null },
		};
	};
	return { fetchImpl, calls };
}

const token = (n = 1, extra = {}) => () => [200, { access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 3600, name: 'Owner', email: 'owner@example.com', ...extra }];
const ok = (data, extra = {}) => [200, { message: 'Success', data, errors: null, ...extra }];

test('trades the Client ID and secret for a token at /auth/token, then sends it as a bearer token', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': token(),
		'GET /v1/sites': () => ok([{ id: 1 }], { page: { currentPage: 1, lastPage: 1 } }),
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's&cret', fetchImpl, logger: quiet });
	const result = await api.validate();
	assert.deepEqual(result, { sites: 1, name: 'Owner', email: 'owner@example.com' });
	assert.equal(calls[0].url.origin, 'https://my.pressable.com');
	const form = new URLSearchParams(calls[0].init.body);
	assert.deepEqual([...form.entries()], [['grant_type', 'client_credentials'], ['client_id', 'id'], ['client_secret', 's&cret']]);
	assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
	assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1');
});

test('reuses a token until shortly before it expires', async () => {
	let now = 0;
	let n = 0;
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': () => token((n += 1))(),
		'GET /v1/sites/7': () => ok({ id: 7 }),
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet, now: () => now });
	await api.getSite(7);
	now = 30 * 60 * 1000;
	await api.getSite(7);
	now = 59.5 * 60 * 1000;
	await api.getSite(7);
	assert.deepEqual(calls.map((c) => c.key), ['POST /auth/token', 'GET /v1/sites/7', 'GET /v1/sites/7', 'POST /auth/token', 'GET /v1/sites/7']);
	assert.equal(calls[4].init.headers.Authorization, 'Bearer tok-2');
});

test('gets a new token once when Pressable rejects the current one', async () => {
	let n = 0;
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': () => token((n += 1))(),
		'GET /v1/sites/7': (u, init) => (init.headers.Authorization === 'Bearer tok-1' ? [401, { message: 'Unauthorized', data: null, errors: ['Token revoked'] }] : ok({ id: 7 })),
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet });
	assert.deepEqual(await api.getSite(7), { id: 7 });
	assert.deepEqual(calls.map((c) => c.key), ['POST /auth/token', 'GET /v1/sites/7', 'POST /auth/token', 'GET /v1/sites/7']);
});

test('explains rejected credentials, a revoked application and missing scopes', async () => {
	const bad = fakeFetch({ 'POST /auth/token': () => [401, { error: 'invalid_client', error_description: 'Client authentication failed' }] });
	await assert.rejects(new PressableApi({ clientId: 'id', clientSecret: 'x', fetchImpl: bad.fetchImpl, logger: quiet }).validate(),
		/rejected this Client ID and Client Secret\. Check them in MyPressable → API Applications/);

	const revoked = fakeFetch({ 'POST /auth/token': token(), 'GET /v1/sites/1': () => [401, { message: 'Unauthorized', data: null, errors: ['No'] }] });
	await assert.rejects(new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl: revoked.fetchImpl, logger: quiet }).getSite(1),
		/no longer accepts this API application/);

	const scoped = fakeFetch({ 'POST /auth/token': token(), 'DELETE /v1/sites/1/edge-cache': () => [403, { message: 'Forbidden', data: null, errors: ['Missing scope'] }] });
	await assert.rejects(new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl: scoped.fetchImpl, logger: quiet }).purgeEdgeCache(1),
		/isn't allowed to DELETE \/v1\/sites\/1\/edge-cache.*edit access to Sites/);
});

test('explains a network failure instead of passing on fetch\'s bare "fetch failed"', async () => {
	const fetchImpl = async () => {
		const e = new TypeError('fetch failed');
		e.cause = { code: 'ENOTFOUND' };
		throw e;
	};
	await assert.rejects(new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet }).listSites(),
		/Could not reach Pressable's API \(ENOTFOUND\)\. Check your internet connection/);
});

test('lists every page of sites, 50 at a time, following lastPage', async () => {
	const all = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': token(),
		'GET /v1/sites': (u) => {
			const page = Number(u.searchParams.get('page'));
			const per = Number(u.searchParams.get('per_page'));
			return ok(all.slice((page - 1) * per, page * per), { page: { currentPage: page, lastPage: Math.ceil(all.length / per), perPage: per, totalItems: all.length } });
		},
	});
	const sites = await new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet }).listSites();
	assert.equal(sites.length, 120);
	const pages = calls.filter((c) => c.key === 'GET /v1/sites');
	assert.deepEqual(pages.map((c) => [c.url.searchParams.get('page'), c.url.searchParams.get('per_page'), c.url.searchParams.get('paginate')]),
		[['1', '50', 'true'], ['2', '50', 'true'], ['3', '50', 'true']]);
});

test('stops paging at an empty page, and at a short page when there is no page info', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': token(),
		'GET /v1/sites': (u) => (u.searchParams.get('page') === '1' ? ok([{ id: 1 }, { id: 2 }]) : ok([])),
	});
	const sites = await new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet }).listSites();
	assert.equal(sites.length, 2);
	assert.equal(calls.filter((c) => c.key === 'GET /v1/sites').length, 1);
});

test('reads a site, its SFTP users and domains; an unknown site is null and failed domains are []', async () => {
	const { fetchImpl } = fakeFetch({
		'POST /auth/token': token(),
		'GET /v1/sites/5': () => ok({ id: 5, url: 'a.example' }),
		'GET /v1/sites/6': () => [404, { message: 'Not Found', data: null, errors: ['Site not found'] }],
		'GET /v1/sites/5/ftp': () => ok([{ username: 'abc', owner: true }]),
		'GET /v1/sites/5/domains': () => [500, { message: 'Error', data: null, errors: ['Boom'] }],
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet });
	assert.deepEqual(await api.getSite(5), { id: 5, url: 'a.example' });
	assert.equal(await api.getSite(6), null);
	assert.deepEqual(await api.listSftpUsers(5), [{ username: 'abc', owner: true }]);
	assert.deepEqual(await api.listDomains(5), []);
});

test('purges the Edge Cache and flushes the object cache with DELETE', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': token(),
		'DELETE /v1/sites/9/edge-cache': () => ok(null),
		'DELETE /v1/sites/9/object-cache': () => ok(null),
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet });
	await api.purgeEdgeCache(9);
	await api.flushObjectCache(9);
	assert.deepEqual(calls.map((c) => c.key).slice(1), ['DELETE /v1/sites/9/edge-cache', 'DELETE /v1/sites/9/object-cache']);
});

test('reads Pressable\'s error bodies', () => {
	assert.equal(errorMessageFrom({ message: 'There was a problem processing your request.', data: null, errors: ['You have reached the throttling limit'] }, 429),
		'You have reached the throttling limit');
	assert.equal(errorMessageFrom({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401), 'Client authentication failed');
	assert.equal(errorMessageFrom({ message: 'Site is locked', data: null, errors: null }, 409), 'Site is locked');
	assert.equal(errorMessageFrom(null, 502), 'Pressable API request failed (HTTP 502)');
});

test('retries after a rate limit, waiting as long as Retry-After says', async () => {
	let first = true;
	const { fetchImpl, calls } = fakeFetch({
		'POST /auth/token': token(),
		'GET /v1/sites/3': () => {
			if (first) {
				first = false;
				return [429, { message: 'Throttled', data: null, errors: ['Slow down'] }, { 'retry-after': '1' }];
			}
			return ok({ id: 3 });
		},
	});
	const api = new PressableApi({ clientId: 'id', clientSecret: 's', fetchImpl, logger: quiet });
	const started = Date.now();
	assert.deepEqual(await api.getSite(3), { id: 3 });
	assert.ok(Date.now() - started >= 900 && Date.now() - started < 4000);
	assert.equal(calls.filter((c) => c.key === 'GET /v1/sites/3').length, 2);
});

test('requires both a Client ID and a Client Secret', () => {
	assert.throws(() => new PressableApi({ clientId: 'id', clientSecret: '' }), /Client ID and Client Secret are required/);
});
