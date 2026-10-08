console.log('🐾 Starting...');

import { Worker } from 'worker_threads';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { watchFile, unwatchFile } from 'fs';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rl = readline.createInterface(process.stdin, process.stdout);

let worker = null;
let running = false;
let restartTimer = null;
let crashCount = 0;

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60 * 1000;
const STABLE_UPTIME_MS = 60 * 1000;

function start(file) {
	if (running) return;
	running = true;
	const full = join(__dirname, file);

	if (worker) worker.terminate();
	worker = new Worker(full);
	const current = worker;
	const startedAt = Date.now();
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}

	worker.on('message', (msg) => {
		console.log('[MESSAGE]', msg);

		if (msg === 'restart' || msg === 'reset') {
			restart();
		}
	});

	worker.on('exit', (code) => {
		console.log('❗ Worker exited with code', code);
		// Ignore exits from a superseded worker (e.g. terminated by restart())
		if (current !== worker) return;
		running = false;

		if (Date.now() - startedAt > STABLE_UPTIME_MS) {
			crashCount = 0;
		}

		if (code !== 0) {
			crashCount++;
			const delay = Math.min(
				BASE_DELAY_MS * 2 ** (crashCount - 1),
				MAX_DELAY_MS
			);
			if (restartTimer) clearTimeout(restartTimer);
			console.log(`⏳ Restarting in ${delay} ms (attempt ${crashCount})`);
			restartTimer = setTimeout(() => {
				restartTimer = null;
				restart();
			}, delay);
		}
		watchFile(full, () => {
			unwatchFile(full);
			console.log('♻️ File updated → Restarting...');
			start(file);
		});
	});

	if (!rl.listenerCount('line')) {
		rl.on('line', (line) => {
			const cmd = line.trim().toLowerCase();
			if (!cmd) return;

			if (cmd === 'exit') {
				console.log('⛔ Exiting...');
				worker?.terminate();
				process.exit(0);
			}
			if (cmd === 'restart' || cmd === 'reset') {
				console.log('🍃Restart...');
				restart();
			}

			worker?.postMessage(cmd);
		});
	}
}

function restart() {
	if (worker) {
		try {
			worker.terminate();
		} catch {}
	}
	running = false;

	start('main.js');
}

start('main.js');
