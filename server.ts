import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

interface SavedStream {
  id: string;
  title: string;
  url: string;
  addedAt: string;
  kind: 'online';
}

interface LocalVideo {
  id: string;
  name: string;
  folder: string;
  url: string;
  kind: 'local';
}

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.basename(SCRIPT_DIR) === 'dist'
  ? path.resolve(SCRIPT_DIR, '..')
  : SCRIPT_DIR;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const STREAMS_FILE = path.join(DATA_DIR, 'online-sources.json');
const MAX_BODY_BYTES = 32 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB per file

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.ogv', '.ogg', '.mkv', '.avi',
]);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendMessage(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function ensureFolders(): Promise<void> {
  await Promise.all([
    fs.mkdir(PUBLIC_DIR, { recursive: true }),
    fs.mkdir(MEDIA_DIR, { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
  ]);

  try {
    await fs.access(STREAMS_FILE);
  } catch {
    await fs.writeFile(STREAMS_FILE, '[]\n', 'utf8');
  }
}

async function readStreams(): Promise<SavedStream[]> {
  try {
    const raw = await fs.readFile(STREAMS_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is SavedStream =>
      item !== null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.title === 'string' &&
      typeof item.url === 'string' &&
      typeof item.addedAt === 'string' &&
      item.kind === 'online'
    );
  } catch (error) {
    console.error('Could not read saved streams:', error);
    return [];
  }
}

async function writeStreams(streams: SavedStream[]): Promise<void> {
  const temporaryFile = `${STREAMS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(streams, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryFile, STREAMS_FILE);
}

function cleanUploadFilename(rawName: string | null): string | null {
  if (!rawName) return null;
  const leafName = rawName.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = leafName.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/g, '');
  if (!cleaned || cleaned.startsWith('.')) return null;

  const extension = path.extname(cleaned).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) return null;

  const baseName = path.basename(cleaned, path.extname(cleaned)).slice(0, 150).trim();
  return baseName ? `${baseName}${extension}` : null;
}

async function getAvailableMediaPath(filename: string): Promise<string> {
  const extension = path.extname(filename);
  const baseName = filename.slice(0, -extension.length);
  let candidateName = filename;
  let suffix = 2;

  while (true) {
    const candidatePath = path.join(MEDIA_DIR, candidateName);
    try {
      await fs.access(candidatePath);
      candidateName = `${baseName} (${suffix})${extension}`;
      suffix += 1;
    } catch {
      return candidatePath;
    }
  }
}

async function saveUploadedVideo(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const filename = cleanUploadFilename(url.searchParams.get('name'));
  if (!filename) {
    req.resume();
    sendMessage(res, 400, 'Choose a supported video file (MP4, WebM, MOV, MKV, AVI, OGV, or M4V).');
    return;
  }

  const contentLengthHeader = req.headers['content-length'];
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    req.resume();
    sendMessage(res, 413, 'This file is larger than the 20 GiB per-file upload limit.');
    return;
  }

  const temporaryPath = path.join(MEDIA_DIR, `.upload-${crypto.randomUUID()}.part`);
  try {
    // Stream directly to disk so large episodes are not loaded into RAM.
    await pipeline(req, createWriteStream(temporaryPath, { flags: 'wx' }));

    const stats = await fs.stat(temporaryPath);
    if (stats.size === 0) {
      await fs.rm(temporaryPath, { force: true });
      sendMessage(res, 400, 'The uploaded file is empty.');
      return;
    }
    if (stats.size > MAX_UPLOAD_BYTES) {
      await fs.rm(temporaryPath, { force: true });
      sendMessage(res, 413, 'This file is larger than the 20 GiB per-file upload limit.');
      return;
    }

    const finalPath = await getAvailableMediaPath(filename);
    await fs.rename(temporaryPath, finalPath);
    const savedName = path.basename(finalPath);
    const localVideo: LocalVideo = {
      id: savedName,
      name: savedName,
      folder: '',
      url: `/media/${encodeURIComponent(savedName)}`,
      kind: 'local',
    };
    sendJson(res, 201, { ok: true, video: localVideo, size: stats.size });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    console.error('Video upload failed:', error);
    if (!res.headersSent) sendMessage(res, 500, 'Upload failed. Check that the media folder has enough free space and is writable.');
    else res.destroy(error instanceof Error ? error : undefined);
  }
}

async function scanMediaFolder(directory: string, relativeDirectory = ''): Promise<LocalVideo[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const videos: LocalVideo[] = [];

  for (const entry of entries) {
    // Ignore symlinks so the library cannot escape the media folder.
    if (entry.isSymbolicLink()) continue;

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      videos.push(...await scanMediaFolder(absolutePath, relativePath));
      continue;
    }

    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const encodedPath = relativePath
      .split(path.sep)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    videos.push({
      id: relativePath.split(path.sep).join('/'),
      name: entry.name,
      folder: relativeDirectory.split(path.sep).join('/'),
      url: `/media/${encodedPath}`,
      kind: 'local',
    });
  }

  return videos;
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function safeResolve(baseDirectory: string, encodedPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  if (decodedPath.includes('\0')) return null;
  const normalized = decodedPath.replace(/[\\/]+/g, path.sep).replace(/^[/\\]+/, '');
  const resolvedBase = path.resolve(baseDirectory);
  const resolvedTarget = path.resolve(resolvedBase, normalized);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolvedTarget;
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  allowRanges: boolean,
): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    sendMessage(res, 404, 'File not found.');
    return;
  }

  if (!stats.isFile()) {
    sendMessage(res, 404, 'File not found.');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const headers: Record<string, string | number> = {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': allowRanges ? 'private, max-age=3600' : 'no-cache',
  };

  if (allowRanges) headers['Accept-Ranges'] = 'bytes';

  let start = 0;
  let end = Math.max(0, stats.size - 1);
  let status = 200;

  const rangeHeader = allowRanges ? req.headers.range : undefined;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || stats.size === 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    if (match[1] === '') {
      const suffixLength = Number.parseInt(match[2] || '0', 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        res.end();
        return;
      }
      start = Math.max(0, stats.size - suffixLength);
    } else {
      start = Number.parseInt(match[1], 10);
      if (match[2] !== '') end = Number.parseInt(match[2], 10);
    }

    if (start >= stats.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    end = Math.min(end, stats.size - 1);
    status = 206;
    headers['Content-Length'] = end - start + 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
  }

  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on('error', (error) => {
    console.error('File stream error:', error);
    if (!res.headersSent) sendMessage(res, 500, 'Could not read this file.');
    else res.destroy(error);
  });
  stream.pipe(res);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, name: 'Yozora Anime Player' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    try {
      const [local, online] = await Promise.all([scanMediaFolder(MEDIA_DIR), readStreams()]);
      local.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      online.sort((a, b) => a.title.localeCompare(b.title));
      sendJson(res, 200, { local, online });
    } catch (error) {
      console.error('Library scan failed:', error);
      sendMessage(res, 500, 'Could not scan the media folder. Check folder permissions.');
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    await saveUploadedVideo(req, res, url);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/streams') {
    let body: Record<string, unknown>;
    try {
      body = await readRequestJson(req);
    } catch (error) {
      sendMessage(res, 400, error instanceof Error ? error.message : 'Invalid JSON request.');
      return true;
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';

    if (!title || title.length > 120) {
      sendMessage(res, 400, 'Enter a stream name (up to 120 characters).');
      return true;
    }
    if (!rawUrl || rawUrl.length > 4096) {
      sendMessage(res, 400, 'Enter a direct video or HLS URL.');
      return true;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      sendMessage(res, 400, 'That URL is not valid.');
      return true;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      sendMessage(res, 400, 'Only HTTP or HTTPS stream URLs are supported.');
      return true;
    }

    const streams = await readStreams();
    const normalizedUrl = parsedUrl.toString();
    if (streams.some((stream) => stream.url === normalizedUrl)) {
      sendMessage(res, 409, 'That stream is already saved in your library.');
      return true;
    }

    const newStream: SavedStream = {
      id: crypto.randomUUID(),
      title,
      url: normalizedUrl,
      addedAt: new Date().toISOString(),
      kind: 'online',
    };

    try {
      await writeStreams([...streams, newStream]);
      sendJson(res, 201, newStream);
    } catch (error) {
      console.error('Could not save stream:', error);
      sendMessage(res, 500, 'Could not save the stream. Check write permissions for the data folder.');
    }
    return true;
  }

  const deleteMatch = /^\/api\/streams\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    let streamId: string;
    try {
      streamId = decodeURIComponent(deleteMatch[1]);
    } catch {
      sendMessage(res, 400, 'Invalid stream ID.');
      return true;
    }

    const streams = await readStreams();
    const remaining = streams.filter((stream) => stream.id !== streamId);
    if (remaining.length === streams.length) {
      sendMessage(res, 404, 'Saved stream not found.');
      return true;
    }

    try {
      await writeStreams(remaining);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('Could not remove stream:', error);
      sendMessage(res, 500, 'Could not remove the saved stream.');
    }
    return true;
  }

  return false;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (await handleApi(req, res, requestUrl)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMessage(res, 405, 'Method not allowed.');
    return;
  }

  if (pathname === '/media' || pathname.startsWith('/media/')) {
    const encodedPath = pathname === '/media' ? '' : pathname.slice('/media/'.length);
    const filePath = safeResolve(MEDIA_DIR, encodedPath);
    if (!filePath || filePath === MEDIA_DIR) {
      sendMessage(res, 400, 'Invalid media path.');
      return;
    }
    await serveFile(req, res, filePath, true);
    return;
  }

  const publicPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = safeResolve(PUBLIC_DIR, publicPath);
  if (!filePath) {
    sendMessage(res, 400, 'Invalid file path.');
    return;
  }
  await serveFile(req, res, filePath, false);
}

async function start(): Promise<void> {
  await ensureFolders();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      console.error('Request failed:', error);
      if (!res.headersSent) sendMessage(res, 500, 'The server could not complete this request.');
      else res.destroy(error instanceof Error ? error : undefined);
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to another number.`);
    } else {
      console.error('Server error:', error);
    }
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ✦ YOZORA Anime Player is running');
    console.log(`  Local URL:  http://${HOST}:${PORT}`);
    console.log(`  Media:      ${MEDIA_DIR}`);
    console.log(`  Health:     http://${HOST}:${PORT}/health`);
    console.log('');
  });
}

start().catch((error: unknown) => {
  console.error('Could not initialize Yozora:', error);
  process.exitCode = 1;
});
