/**
 * Google Workspace MCP Server for NanoClaw
 * Provides Gmail and Calendar tools using per-group OAuth credentials.
 * Credentials are saved by the connect-google container skill.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

/** Strip path separators and '..' to prevent path traversal */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/\.\./g, '_') || 'download';
}

/** Strip CRLF to prevent email header injection */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

const CREDENTIALS_PATH = '/workspace/group/.google-credentials.json';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

interface GoogleCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

let cachedCredentials: GoogleCredentials | null = null;

function loadCredentials(): GoogleCredentials | null {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    cachedCredentials = data;
    return data;
  } catch {
    return null;
  }
}

function saveCredentials(creds: GoogleCredentials): void {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  cachedCredentials = creds;
}

async function getAccessToken(): Promise<string> {
  let creds = cachedCredentials || loadCredentials();
  if (!creds) throw new Error('Not authenticated. Run /connect-google first.');

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= creds.expiry_date - 60_000) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token refresh failed: ${err}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    creds.access_token = data.access_token;
    creds.expiry_date = Date.now() + data.expires_in * 1000;
    saveCredentials(creds);
  }

  return creds.access_token;
}

async function googleApi(url: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API error (${res.status}): ${err}`);
  }

  return res.json();
}

async function googleApiRaw(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API error (${res.status}): ${err}`);
  }
  return res;
}

// --- Server setup ---

const server = new McpServer({
  name: 'google',
  version: '1.0.0',
});

// --- Auth tools ---

server.tool(
  'google_auth_url',
  'Generate a Google OAuth authorization URL. Send this to the user so they can log in.',
  {},
  async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return {
        content: [{ type: 'text' as const, text: 'Error: GOOGLE_CLIENT_ID is not configured.' }],
        isError: true,
      };
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'http://localhost:1',
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    return {
      content: [{
        type: 'text' as const,
        text: url,
      }],
    };
  },
);

server.tool(
  'google_auth_exchange',
  'Exchange an authorization code for tokens. The code comes from the redirect URL the user copies after Google login.',
  {
    code: z.string().describe('The authorization code from the redirect URL (the ?code= parameter)'),
  },
  async (args) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return {
        content: [{ type: 'text' as const, text: 'Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured.' }],
        isError: true,
      };
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: args.code,
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:1',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        content: [{ type: 'text' as const, text: `Token exchange failed: ${err}` }],
        isError: true,
      };
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };

    const creds: GoogleCredentials = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expiry_date: Date.now() + data.expires_in * 1000,
    };

    saveCredentials(creds);

    return {
      content: [{ type: 'text' as const, text: 'Google account connected successfully.' }],
    };
  },
);

server.tool(
  'google_auth_status',
  'Check if Google account is connected for this chat.',
  {},
  async () => {
    const creds = loadCredentials();
    if (!creds) {
      return { content: [{ type: 'text' as const, text: 'Not connected. Use /connect-google to authenticate.' }] };
    }
    const expired = Date.now() >= creds.expiry_date;
    return {
      content: [{
        type: 'text' as const,
        text: `Connected. Token ${expired ? 'expired (will auto-refresh)' : 'valid'}.`,
      }],
    };
  },
);

server.tool(
  'google_disconnect',
  'Disconnect Google account. Revokes the token with Google and deletes local credentials.',
  {},
  async () => {
    const creds = loadCredentials();
    if (!creds) {
      return { content: [{ type: 'text' as const, text: 'Not connected.' }] };
    }

    // Revoke token with Google
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(creds.refresh_token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
    } catch { /* best effort — delete local credentials regardless */ }

    // Delete local credentials
    try { fs.unlinkSync(CREDENTIALS_PATH); } catch { /* ignore */ }
    cachedCredentials = null;

    return { content: [{ type: 'text' as const, text: 'Google account disconnected and token revoked.' }] };
  },
);

// --- Gmail tools ---

server.tool(
  'gmail_search',
  'Search Gmail messages. Returns a list of matching emails with id, subject, from, date, and snippet.',
  {
    query: z.string().describe('Gmail search query (e.g., "from:boss subject:meeting", "is:unread", "newer_than:1d")'),
    max_results: z.number().default(10).describe('Maximum number of results (default 10)'),
  },
  async (args) => {
    const params = new URLSearchParams({
      q: args.query,
      maxResults: String(args.max_results),
    });
    const list = await googleApi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    ) as { messages?: { id: string }[] };

    if (!list.messages?.length) {
      return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
    }

    const results = [];
    for (const msg of list.messages.slice(0, args.max_results)) {
      const detail = await googleApi(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      ) as { id: string; snippet: string; payload: { headers: { name: string; value: string }[] } };

      const headers = detail.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      results.push(`[${detail.id}] ${date}\nFrom: ${from}\nSubject: ${subject}\n${detail.snippet}\n`);
    }

    return { content: [{ type: 'text' as const, text: results.join('\n---\n') }] };
  },
);

server.tool(
  'gmail_read',
  'Read full email content by message ID.',
  {
    message_id: z.string().describe('Gmail message ID'),
  },
  async (args) => {
    interface MimePart {
      mimeType: string;
      body?: { data?: string };
      parts?: MimePart[];
    }

    function findBodyText(part: MimePart): string | null {
      if (part.body?.data && (part.mimeType === 'text/plain' || part.mimeType === 'text/html')) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      if (part.parts) {
        // Prefer text/plain over text/html
        for (const mime of ['text/plain', 'text/html']) {
          for (const child of part.parts) {
            if (child.mimeType === mime && child.body?.data) {
              return Buffer.from(child.body.data, 'base64url').toString('utf-8');
            }
          }
        }
        // Recurse into nested multipart
        for (const child of part.parts) {
          const found = findBodyText(child);
          if (found) return found;
        }
      }
      return null;
    }

    const msg = await googleApi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.message_id}?format=full`,
    ) as { payload: MimePart & { headers: { name: string; value: string }[] } };

    const headers = msg.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    const to = headers.find(h => h.name === 'To')?.value || '';

    const body = findBodyText(msg.payload) || '';

    return {
      content: [{
        type: 'text' as const,
        text: `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`,
      }],
    };
  },
);

server.tool(
  'gmail_send',
  'Send an email.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
    bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
  },
  async (args) => {
    const lines = [
      `To: ${sanitizeHeader(args.to)}`,
      `Subject: ${sanitizeHeader(args.subject)}`,
      ...(args.cc ? [`Cc: ${sanitizeHeader(args.cc)}`] : []),
      ...(args.bcc ? [`Bcc: ${sanitizeHeader(args.bcc)}`] : []),
      'Content-Type: text/plain; charset=utf-8',
      '',
      args.body,
    ];

    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

    await googleApi('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });

    return { content: [{ type: 'text' as const, text: `Email sent to ${sanitizeHeader(args.to)}.` }] };
  },
);

server.tool(
  'gmail_list_labels',
  'List all Gmail labels.',
  {},
  async () => {
    const data = await googleApi(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    ) as { labels: { id: string; name: string; type: string }[] };

    const text = data.labels
      .map(l => `${l.name} (${l.type})`)
      .join('\n');

    return { content: [{ type: 'text' as const, text: text || 'No labels found.' }] };
  },
);

server.tool(
  'gmail_list_attachments',
  'List attachments for a Gmail message. Returns attachment IDs, filenames, and sizes.',
  {
    message_id: z.string().describe('Gmail message ID'),
  },
  async (args) => {
    const msg = await googleApi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.message_id}?format=full`,
    ) as {
      payload: {
        parts?: {
          filename?: string;
          mimeType: string;
          body?: { attachmentId?: string; size?: number };
          parts?: { filename?: string; mimeType: string; body?: { attachmentId?: string; size?: number } }[];
        }[];
      };
    };

    const attachments: { id: string; filename: string; mimeType: string; size: number }[] = [];

    function collectAttachments(parts: typeof msg.payload.parts) {
      if (!parts) return;
      for (const part of parts) {
        if (part.body?.attachmentId && part.filename) {
          attachments.push({
            id: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size || 0,
          });
        }
        if (part.parts) collectAttachments(part.parts);
      }
    }

    collectAttachments(msg.payload.parts);

    if (!attachments.length) {
      return { content: [{ type: 'text' as const, text: 'No attachments found.' }] };
    }

    const text = attachments.map(a =>
      `[${a.id}] ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB)`
    ).join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'gmail_download_attachment',
  'Download a Gmail attachment and save it to the workspace. Returns the saved file path.',
  {
    message_id: z.string().describe('Gmail message ID'),
    attachment_id: z.string().describe('Attachment ID (from gmail_list_attachments)'),
    filename: z.string().describe('Filename to save as'),
  },
  async (args) => {
    const data = await googleApi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.message_id}/attachments/${args.attachment_id}`,
    ) as { data: string };

    const buffer = Buffer.from(data.data, 'base64url');
    const dir = '/workspace/group/downloads';
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, sanitizeFilename(args.filename));
    fs.writeFileSync(filePath, buffer);

    return { content: [{ type: 'text' as const, text: `Saved to ${filePath} (${Math.round(buffer.length / 1024)}KB)` }] };
  },
);

server.tool(
  'gmail_send_with_attachment',
  'Send an email with a file attachment.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    file_path: z.string().describe('Path to the file to attach'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return { content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }], isError: true };
    }

    const fileContent = fs.readFileSync(args.file_path);
    const filename = sanitizeFilename(args.file_path.split('/').pop() || 'attachment');
    const boundary = `boundary_${Date.now()}`;

    const messageParts = [
      `To: ${sanitizeHeader(args.to)}`,
      ...(args.cc ? [`Cc: ${sanitizeHeader(args.cc)}`] : []),
      `Subject: ${sanitizeHeader(args.subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      args.body,
      '',
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      fileContent.toString('base64'),
      '',
      `--${boundary}--`,
    ];

    const raw = Buffer.from(messageParts.join('\r\n')).toString('base64url');

    await googleApi('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });

    return { content: [{ type: 'text' as const, text: `Email with attachment "${filename}" sent to ${sanitizeHeader(args.to)}.` }] };
  },
);

// --- Drive tools ---

server.tool(
  'drive_search',
  'Search files in Google Drive. Returns file IDs, names, types, and sizes.',
  {
    query: z.string().describe('Search query (e.g., "name contains \'report\'", "mimeType=\'application/pdf\'", "modifiedTime > \'2026-01-01\'"). Use Google Drive query syntax.'),
    max_results: z.number().default(10).describe('Maximum results'),
  },
  async (args) => {
    const params = new URLSearchParams({
      q: args.query,
      pageSize: String(args.max_results),
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
    });

    const data = await googleApi(
      `https://www.googleapis.com/drive/v3/files?${params}`,
    ) as { files: { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; webViewLink?: string }[] };

    if (!data.files?.length) {
      return { content: [{ type: 'text' as const, text: 'No files found.' }] };
    }

    const text = data.files.map(f => {
      const size = f.size ? `${Math.round(parseInt(f.size) / 1024)}KB` : 'N/A';
      return `[${f.id}] ${f.name}\n  Type: ${f.mimeType} | Size: ${size} | Modified: ${f.modifiedTime}${f.webViewLink ? `\n  ${f.webViewLink}` : ''}`;
    }).join('\n\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'drive_list',
  'List files in Google Drive, optionally within a specific folder.',
  {
    folder_id: z.string().default('root').describe('Folder ID (default: root)'),
    max_results: z.number().default(20).describe('Maximum results'),
  },
  async (args) => {
    const params = new URLSearchParams({
      q: `'${args.folder_id}' in parents and trashed = false`,
      pageSize: String(args.max_results),
      fields: 'files(id,name,mimeType,size,modifiedTime)',
      orderBy: 'modifiedTime desc',
    });

    const data = await googleApi(
      `https://www.googleapis.com/drive/v3/files?${params}`,
    ) as { files: { id: string; name: string; mimeType: string; size?: string; modifiedTime: string }[] };

    if (!data.files?.length) {
      return { content: [{ type: 'text' as const, text: 'No files found.' }] };
    }

    const text = data.files.map(f => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      const size = f.size ? `${Math.round(parseInt(f.size) / 1024)}KB` : '';
      return `${isFolder ? '📁' : '📄'} ${f.name} [${f.id}]${size ? ` (${size})` : ''}`;
    }).join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'drive_read',
  'Read the text content of a Google Drive file. Works with Google Docs (exported as plain text), text files, and other text-based formats.',
  {
    file_id: z.string().describe('File ID'),
  },
  async (args) => {
    // First get file metadata to determine type
    const meta = await googleApi(
      `https://www.googleapis.com/drive/v3/files/${args.file_id}?fields=id,name,mimeType,size`,
    ) as { id: string; name: string; mimeType: string; size?: string };

    let content: string;

    if (meta.mimeType === 'application/vnd.google-apps.document') {
      // Google Docs — export as plain text
      const res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}/export?mimeType=text/plain`,
      );
      content = await res.text();
    } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Google Sheets — export as CSV
      const res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}/export?mimeType=text/csv`,
      );
      content = await res.text();
    } else if (meta.mimeType === 'application/vnd.google-apps.presentation') {
      // Google Slides — export as plain text
      const res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}/export?mimeType=text/plain`,
      );
      content = await res.text();
    } else {
      // Regular file — download content
      const res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}?alt=media`,
      );
      const buf = Buffer.from(await res.arrayBuffer());
      // Try to read as text, fallback to base64 info
      try {
        content = buf.toString('utf-8');
        // Check if it's likely binary
        if (content.includes('\0')) {
          content = `[Binary file: ${meta.name} (${meta.mimeType}, ${buf.length} bytes). Use drive_download to save it.]`;
        }
      } catch {
        content = `[Binary file: ${meta.name} (${meta.mimeType}, ${buf.length} bytes). Use drive_download to save it.]`;
      }
    }

    return { content: [{ type: 'text' as const, text: `File: ${meta.name}\nType: ${meta.mimeType}\n\n${content}` }] };
  },
);

server.tool(
  'drive_download',
  'Download a file from Google Drive to the workspace.',
  {
    file_id: z.string().describe('File ID'),
    filename: z.string().optional().describe('Filename to save as (auto-detected if omitted)'),
  },
  async (args) => {
    const meta = await googleApi(
      `https://www.googleapis.com/drive/v3/files/${args.file_id}?fields=name,mimeType`,
    ) as { name: string; mimeType: string };

    let res: Response;
    let filename = args.filename || meta.name;

    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      // Google native format — export
      const exportMap: Record<string, { mime: string; ext: string }> = {
        'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
        'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: '.csv' },
        'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
      };
      const exp = exportMap[meta.mimeType] || { mime: 'application/pdf', ext: '.pdf' };
      res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}/export?mimeType=${encodeURIComponent(exp.mime)}`,
      );
      if (!filename.endsWith(exp.ext)) filename += exp.ext;
    } else {
      res = await googleApiRaw(
        `https://www.googleapis.com/drive/v3/files/${args.file_id}?alt=media`,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const dir = '/workspace/group/downloads';
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, sanitizeFilename(filename));
    fs.writeFileSync(filePath, buffer);

    return { content: [{ type: 'text' as const, text: `Downloaded to ${filePath} (${Math.round(buffer.length / 1024)}KB)` }] };
  },
);

server.tool(
  'drive_upload',
  'Upload a file to Google Drive.',
  {
    file_path: z.string().describe('Local file path to upload'),
    folder_id: z.string().default('root').describe('Parent folder ID (default: root)'),
    name: z.string().optional().describe('File name in Drive (defaults to local filename)'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return { content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }], isError: true };
    }

    const filename = args.name || args.file_path.split('/').pop() || 'upload';
    const fileContent = fs.readFileSync(args.file_path);

    const boundary = `boundary_${Date.now()}`;
    const metadata = JSON.stringify({
      name: filename,
      parents: [args.folder_id],
    });

    // Build multipart body with raw binary (not base64)
    // Google Drive API does NOT decode Content-Transfer-Encoding
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([preamble, fileContent, epilogue]);

    const token = await getAccessToken();
    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return { content: [{ type: 'text' as const, text: `Upload failed: ${err}` }], isError: true };
    }

    const file = await res.json() as { id: string; name: string; webViewLink?: string };
    return {
      content: [{
        type: 'text' as const,
        text: `Uploaded: ${file.name} [${file.id}]${file.webViewLink ? `\n${file.webViewLink}` : ''}`,
      }],
    };
  },
);

server.tool(
  'drive_create_folder',
  'Create a folder in Google Drive.',
  {
    name: z.string().describe('Folder name'),
    parent_id: z.string().default('root').describe('Parent folder ID (default: root)'),
  },
  async (args) => {
    const data = await googleApi(
      'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',
      {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [args.parent_id],
        }),
      },
    ) as { id: string; name: string; webViewLink?: string };

    return {
      content: [{
        type: 'text' as const,
        text: `Folder created: ${data.name} [${data.id}]${data.webViewLink ? `\n${data.webViewLink}` : ''}`,
      }],
    };
  },
);

server.tool(
  'drive_delete',
  'Move a file or folder to trash in Google Drive.',
  {
    file_id: z.string().describe('File or folder ID'),
  },
  async (args) => {
    await googleApi(
      `https://www.googleapis.com/drive/v3/files/${args.file_id}`,
      { method: 'PATCH', body: JSON.stringify({ trashed: true }) },
    );

    return { content: [{ type: 'text' as const, text: `Moved to trash: ${args.file_id}` }] };
  },
);

// --- Calendar tools ---

server.tool(
  'calendar_list_events',
  'List upcoming calendar events.',
  {
    max_results: z.number().default(10).describe('Maximum events to return'),
    calendar_id: z.string().default('primary').describe('Calendar ID (default: primary)'),
    time_min: z.string().optional().describe('Start time (ISO 8601, e.g., "2026-03-19T00:00:00Z"). Defaults to now.'),
    time_max: z.string().optional().describe('End time (ISO 8601). Optional.'),
  },
  async (args) => {
    const params = new URLSearchParams({
      maxResults: String(args.max_results),
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: args.time_min || new Date().toISOString(),
    });
    if (args.time_max) params.set('timeMax', args.time_max);

    const data = await googleApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendar_id)}/events?${params}`,
    ) as { items?: { id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }[] };

    if (!data.items?.length) {
      return { content: [{ type: 'text' as const, text: 'No upcoming events.' }] };
    }

    const text = data.items.map(e => {
      const start = e.start.dateTime || e.start.date || '';
      const end = e.end.dateTime || e.end.date || '';
      let line = `[${e.id}] ${e.summary || '(no title)'}\n  ${start} → ${end}`;
      if (e.location) line += `\n  Location: ${e.location}`;
      if (e.description) line += `\n  ${e.description.slice(0, 200)}`;
      return line;
    }).join('\n\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'calendar_create_event',
  'Create a new calendar event.',
  {
    summary: z.string().describe('Event title'),
    start_time: z.string().describe('Start time (ISO 8601, e.g., "2026-03-20T10:00:00+09:00")'),
    end_time: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    calendar_id: z.string().default('primary').describe('Calendar ID (default: primary)'),
    attendees: z.string().optional().describe('Comma-separated email addresses of attendees'),
  },
  async (args) => {
    const event: Record<string, unknown> = {
      summary: args.summary,
      start: { dateTime: args.start_time },
      end: { dateTime: args.end_time },
    };
    if (args.description) event.description = args.description;
    if (args.location) event.location = args.location;
    if (args.attendees) {
      event.attendees = args.attendees.split(',').map(addr => ({ email: addr.trim() }));
    }

    const created = await googleApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendar_id)}/events`,
      { method: 'POST', body: JSON.stringify(event) },
    ) as { id: string; htmlLink: string };

    return {
      content: [{
        type: 'text' as const,
        text: `Event created: ${created.htmlLink}`,
      }],
    };
  },
);

server.tool(
  'calendar_update_event',
  'Update an existing calendar event.',
  {
    event_id: z.string().describe('Event ID'),
    summary: z.string().optional().describe('New title'),
    start_time: z.string().optional().describe('New start time (ISO 8601)'),
    end_time: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    calendar_id: z.string().default('primary').describe('Calendar ID'),
  },
  async (args) => {
    const patch: Record<string, unknown> = {};
    if (args.summary !== undefined) patch.summary = args.summary;
    if (args.start_time !== undefined) patch.start = { dateTime: args.start_time };
    if (args.end_time !== undefined) patch.end = { dateTime: args.end_time };
    if (args.description !== undefined) patch.description = args.description;
    if (args.location !== undefined) patch.location = args.location;

    await googleApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendar_id)}/events/${args.event_id}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );

    return { content: [{ type: 'text' as const, text: `Event ${args.event_id} updated.` }] };
  },
);

server.tool(
  'calendar_delete_event',
  'Delete a calendar event.',
  {
    event_id: z.string().describe('Event ID'),
    calendar_id: z.string().default('primary').describe('Calendar ID'),
  },
  async (args) => {
    const token = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(args.calendar_id)}/events/${args.event_id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      return { content: [{ type: 'text' as const, text: `Delete failed: ${err}` }], isError: true };
    }

    return { content: [{ type: 'text' as const, text: `Event ${args.event_id} deleted.` }] };
  },
);

server.tool(
  'calendar_list',
  'List all calendars the user has access to.',
  {},
  async () => {
    const data = await googleApi(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    ) as { items: { id: string; summary: string; primary?: boolean; accessRole: string }[] };

    const text = data.items
      .map(c => `${c.summary}${c.primary ? ' (primary)' : ''} [${c.id}] - ${c.accessRole}`)
      .join('\n');

    return { content: [{ type: 'text' as const, text: text || 'No calendars found.' }] };
  },
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
