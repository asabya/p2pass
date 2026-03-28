/**
 * E2E dev server: starts orbitdb-relay-pinner, writes e2e/.bootstrap-peers, runs svelte-package + Vite.
 * Playwright tears this process down after tests (relay + vite stopped together).
 *
 * Relay address for the browser app:
 * 1. This script starts the relay, then polls GET http://localhost:<HTTP_PORT>/multiaddrs (same HTTP
 *    server as /health; HTTP_PORT defaults to 3001 in RELAY.HTTP).
 * 2. The JSON includes `best.websocket` and `byTransport.websocket` — the real libp2p WS listen
 *    multiaddrs. Those are passed to Vite as VITE_BOOTSTRAP_PEERS (see env block below), which
 *    `src/lib/p2p/setup.js` reads at build/dev time.
 * 3. Do not hand-copy relay addresses; the example app always picks up whatever this script discovered.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const RELAY = {
	TCP: '4101',
	WS: '4102',
	WEBRTC: '4103',
	WEBRTC_DIRECT: '4106',
	HTTP: '3001'
};

function httpGet(url) {
	return new Promise((resolvePromise, reject) => {
		const req = http.get(url, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				data += chunk;
			});
			res.on('end', () =>
				resolvePromise({ status: res.statusCode || 0, body: data })
			);
		});
		req.on('error', reject);
		req.end();
	});
}

/**
 * orbitdb-relay-pinner serves GET /multiaddrs with the relay's real listen addresses.
 * We must pass a WebSocket multiaddr that matches what the relay actually listens on —
 * not a reconstructed /ip4/127.0.0.1/tcp/<port>/ws/... string (path/order can differ).
 * Browsers cannot dial /ip4/0.0.0.0/..., so normalize loopback.
 *
 * How the app gets this: Vite is started with VITE_BOOTSTRAP_PEERS=<this string> (see below).
 */
function normalizeMultiaddrForBrowserDial(ma) {
	if (typeof ma !== 'string' || !ma.includes('/p2p/')) return null;
	return ma
		.replace(/\/ip4\/0\.0\.0\.0\//g, '/ip4/127.0.0.1/')
		.replace(/\/ip6\/::\//g, '/ip6/::1/');
}

function pickWebsocketBootstrap(payload) {
	const wsList = Array.isArray(payload.byTransport?.websocket)
		? payload.byTransport.websocket
		: [];
	const candidates = [
		payload.best?.websocket,
		wsList[0],
		...(Array.isArray(payload.all) ? payload.all : []).filter(
			(a) => typeof a === 'string' && a.includes('/ws') && a.includes('/p2p/')
		)
	].filter(Boolean);

	for (const raw of candidates) {
		const ma = normalizeMultiaddrForBrowserDial(raw);
		if (ma) return ma;
	}
	return null;
}

/**
 * Browsers in e2e must dial the relay on loopback. The relay often advertises a LAN IP
 * (e.g. 10.x); WebSocket to that address can fail from the same host. Keep the peer id from
 * /multiaddrs but force /ip4/127.0.0.1/tcp/<wsPort>/ws/p2p/<id>.
 */
function toLoopbackWebsocketBootstrap(ma, wsPort) {
	if (typeof ma !== 'string' || !ma.includes('/p2p/')) return null;
	const peerId = ma.split('/p2p/').pop()?.split('/')[0];
	if (!peerId || !peerId.startsWith('12D')) return null;
	return `/ip4/127.0.0.1/tcp/${wsPort}/ws/p2p/${peerId}`;
}

async function waitForRelayBootstrap(httpPort, { timeoutMs = 90_000, intervalMs = 400 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastErr = null;
	while (Date.now() < deadline) {
		try {
			const res = await httpGet(`http://localhost:${httpPort}/multiaddrs`);
			if (res.status === 200) {
				const payload = JSON.parse(res.body || '{}');
				const picked = pickWebsocketBootstrap(payload);
				if (picked) {
					const loopback = toLoopbackWebsocketBootstrap(picked, RELAY.WS) || picked;
					return { bootstrap: loopback, payload };
				}
			}
			lastErr = new Error('Relay /multiaddrs has no usable WebSocket multiaddr yet');
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw lastErr || new Error('Timed out waiting for relay');
}

console.log('[e2e] Starting local relay + Vite (orbitdb-relay-pinner + example app)…');

const relayCli = resolve(root, 'node_modules', 'orbitdb-relay-pinner', 'dist', 'cli.js');
if (!existsSync(relayCli)) {
	console.error('orbitdb-relay-pinner missing. Run: npm i');
	process.exit(1);
}

const datastore = resolve(root, 'relay', 'test-relay-datastore');
if (existsSync(datastore)) {
	rmSync(datastore, { recursive: true, force: true });
}
mkdirSync(datastore, { recursive: true });

const relayProcess = spawn(process.execPath, [relayCli], {
	cwd: datastore,
	env: {
		...process.env,
		NODE_ENV: 'development',
		RELAY_TCP_PORT: RELAY.TCP,
		RELAY_WS_PORT: RELAY.WS,
		RELAY_WEBRTC_PORT: RELAY.WEBRTC,
		RELAY_WEBRTC_DIRECT_PORT: RELAY.WEBRTC_DIRECT,
		HTTP_PORT: RELAY.HTTP,
		METRICS_PORT: RELAY.HTTP,
		DATASTORE_PATH: datastore,
		PUBSUB_TOPICS: 'p2p-passkeys._peer-discovery._p2p._pubsub',
		RELAY_DISABLE_WEBRTC: 'true',
		STRUCTURED_LOGS: 'false',
		ENABLE_GENERAL_LOGS: 'true'
	},
	// Inherit TTY so relay logs stream to the same console as Playwright (no line-buffering).
	stdio: ['ignore', 'inherit', 'inherit']
});

relayProcess.on('error', (err) => {
	console.error('[e2e] relay:', err);
	process.exit(1);
});
relayProcess.on('exit', (code, signal) => {
	if (code !== 0 && code !== null) {
		console.error('[e2e] relay exited early — code:', code, 'signal:', signal);
	}
});

let bootstrap;
let relayMultiaddrsPayload = null;
try {
	const out = await waitForRelayBootstrap(RELAY.HTTP);
	bootstrap = out.bootstrap;
	relayMultiaddrsPayload = out.payload;
} catch (e) {
	try {
		relayProcess.kill('SIGTERM');
	} catch {
		/* ignore */
	}
	console.error(e);
	process.exit(1);
}

const bootstrapPath = resolve(root, 'e2e', '.bootstrap-peers');
writeFileSync(bootstrapPath, bootstrap, 'utf8');
writeFileSync(
	resolve(root, 'e2e', 'relay-info.json'),
	JSON.stringify({ pid: relayProcess.pid, bootstrap }, null, 2),
	'utf8'
);
console.log('[e2e] Relay PID', relayProcess.pid, '— bootstrap (loopback WS for browser):', bootstrap);
if (relayMultiaddrsPayload?.peerId) {
	console.log(
		'[e2e] Relay /multiaddrs peerId:',
		relayMultiaddrsPayload.peerId,
		'best.ws:',
		relayMultiaddrsPayload.best?.websocket ?? '(none)'
	);
}

const pkg = spawn('npx', ['svelte-package'], { cwd: root, stdio: 'inherit' });
await new Promise((resolvePromise, reject) => {
	pkg.on('error', reject);
	pkg.on('exit', (code) => {
		if (code === 0 || code === null) resolvePromise();
		else reject(new Error(`svelte-package exited ${code}`));
	});
});

const env = {
	...process.env,
	NODE_ENV: 'development',
	VITE_BOOTSTRAP_PEERS: bootstrap,
	VITE_PUBSUB_TOPICS: 'p2p-passkeys._peer-discovery._p2p._pubsub'
};

const vite = spawn(
	process.execPath,
	[
		resolve(root, 'node_modules/vite/bin/vite.js'),
		'--config',
		'example/vite.config.js',
		'--host',
		'localhost',
		'--port',
		'5173',
		'--strictPort'
	],
	{ cwd: root, env, stdio: 'inherit' }
);

function shutdown() {
	try {
		relayProcess.kill('SIGTERM');
	} catch {
		/* ignore */
	}
	try {
		vite.kill('SIGTERM');
	} catch {
		/* ignore */
	}
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

vite.on('error', (err) => {
	console.error(err);
	shutdown();
	process.exit(1);
});

vite.on('exit', (code, signal) => {
	try {
		relayProcess.kill('SIGTERM');
	} catch {
		/* ignore */
	}
	if (signal) process.kill(process.pid, signal);
	process.exit(code ?? 0);
});
