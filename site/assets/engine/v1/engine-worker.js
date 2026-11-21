// 장기 엔진 워커: 단일 스레드 WebAssembly로 빌드한 Fairy-Stockfish를 실행합니다.
// 매 수마다 UCI 명령 묶음을 표준입력으로 넣고 _start를 돌려 bestmove를 받아옵니다.

function runEngine(module, inputText, onLine) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const stdin = enc.encode(inputText);
  let stdinPos = 0;
  let outBuf = '';
  let memory = null;
  const ESUCCESS = 0, EBADF = 8, ENOENT = 44, ENOSYS = 52;

  class Exit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  function emit(text) {
    outBuf += text;
    let i;
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      onLine(line);
    }
  }

  const wasi = {
    args_sizes_get(argcPtr, bufSizePtr) { const v = view(); v.setUint32(argcPtr, 1, true); v.setUint32(bufSizePtr, 3, true); return ESUCCESS; },
    args_get(argvPtr, bufPtr) { const v = view(); v.setUint32(argvPtr, bufPtr, true); bytes().set([115, 102, 0], bufPtr); return ESUCCESS; },
    environ_sizes_get(cPtr, sPtr) { const v = view(); v.setUint32(cPtr, 0, true); v.setUint32(sPtr, 0, true); return ESUCCESS; },
    environ_get() { return ESUCCESS; },
    clock_time_get(id, precision, outPtr) {
      const ms = (typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now());
      view().setBigUint64(outPtr, BigInt(Math.round(ms * 1e6)), true);
      return ESUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      const v = view(); let total = 0; let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        text += dec.decode(bytes().slice(ptr, ptr + len));
        total += len;
      }
      if (fd === 1) emit(text);
      v.setUint32(nwrittenPtr, total, true);
      return ESUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      if (fd !== 0) return EBADF;
      const v = view(); let total = 0;
      for (let i = 0; i < iovsLen && stdinPos < stdin.length; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - stdinPos);
        bytes().set(stdin.subarray(stdinPos, stdinPos + n), ptr);
        stdinPos += n; total += n;
      }
      v.setUint32(nreadPtr, total, true);
      return ESUCCESS;
    },
    fd_fdstat_get(fd, ptr) {
      if (fd > 2) return EBADF;
      const v = view();
      v.setUint8(ptr, fd === 0 ? 2 : 2); // character device
      v.setUint16(ptr + 2, 0, true);
      v.setBigUint64(ptr + 8, 0xffffffffn, true);
      v.setBigUint64(ptr + 16, 0xffffffffn, true);
      return ESUCCESS;
    },
    fd_fdstat_set_flags() { return ESUCCESS; },
    fd_filestat_get() { return EBADF; },
    fd_prestat_get() { return EBADF; },
    fd_prestat_dir_name() { return EBADF; },
    fd_pread() { return EBADF; },
    fd_seek() { return ESUCCESS; },
    fd_close() { return ESUCCESS; },
    path_open() { return ENOENT; },
    proc_exit(code) { throw new Exit(code); },
  };
  const imports = { wasi_snapshot_preview1: new Proxy(wasi, { get: (t, k) => t[k] || (() => ENOSYS) }) };

  return WebAssembly.instantiate(module, imports).then((instance) => {
    memory = instance.exports.memory;
    try { instance.exports._start(); }
    catch (e) { if (!(e instanceof Exit)) throw e; }
    if (outBuf) onLine(outBuf);
  });
}

if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  let modulePromise = null;
  self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === 'init') {
        modulePromise = WebAssembly.compileStreaming
          ? WebAssembly.compileStreaming(fetch(msg.url)).catch(async () => WebAssembly.compile(await (await fetch(msg.url)).arrayBuffer()))
          : fetch(msg.url).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b));
        await modulePromise;
        self.postMessage({ type: 'ready' });
      } else if (msg.type === 'go') {
        const module = await modulePromise;
        let best = null, lastInfo = null;
        await runEngine(module, msg.commands.join('\n') + '\nquit\n', (line) => {
          if (line.startsWith('info depth') && line.includes(' pv ')) { lastInfo = line; self.postMessage({ type: 'info', id: msg.id, line }); }
          if (line.startsWith('bestmove')) best = line.split(' ')[1];
        });
        self.postMessage({ type: 'bestmove', id: msg.id, move: best, info: lastInfo });
      }
    } catch (e) {
      self.postMessage({ type: 'error', id: msg.id, message: String(e && e.message || e) });
    }
  };
}

if (typeof module !== 'undefined') module.exports = { runEngine };
