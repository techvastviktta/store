import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRepo, listFiles, uploadFile, deleteFile } from "@huggingface/hub";

type Bindings = {
  HF_TOKEN?: string;
  HF_BUCKET_NAME?: string;
  HF_SAVE_API_KEY?: string;
  GITHUB_REPO?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

// Helper to parse comma-separated tokens from multiple accounts
function parseTokens(raw?: string): string[] {
  if (!raw) return [];
  let val = raw.trim();
  if (val.startsWith("[") && val.endsWith("]")) {
    val = val.substring(1, val.length - 1);
  }
  return val
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// Executes an async HF SDK operation with automatic token failover across accounts
async function withHfRetry<T>(
  tokens: string[],
  operation: (token: string) => Promise<T>
): Promise<T> {
  if (tokens.length === 0) {
    throw new Error("No Hugging Face tokens configured");
  }
  let lastError: any = null;
  for (const token of tokens) {
    try {
      return await operation(token);
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error("Operation failed with all configured tokens");
}

// Helper to check authentication
function checkAuth(c: any): boolean {
  const apiKey = c.env.HF_SAVE_API_KEY;
  if (!apiKey) return true; // If key is not configured on server, allow write
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.substring(7).trim();
  return token === apiKey;
}

// Health check
app.get("/health", (c) => c.text("OK"));

// CLI Installer Script
app.get("/init", (c) => {
  const platform = (c.req.query("platform") || "").toLowerCase();
  const token = c.req.query("token") || "";
  const host = c.req.header("host") || "localhost";
  const protocol = c.req.header("x-forwarded-proto") || "https";
  const serverUrl = `${protocol}://${host}`;

  if (platform === "windows") {
    const script = `$ServerUrl = "${serverUrl}"
$Token = "${token}"
$BinDir = "$HOME\\.local\\bin"
if (!(Test-Path $BinDir)) { New-Item -ItemType Directory -Force -Path $BinDir }
$ExePath = "$BinDir\\hf-save.exe"
Write-Host "Downloading hf-save CLI for Windows..." -ForegroundColor Cyan
Invoke-WebRequest -Uri "$ServerUrl/bin/windows-amd64" -OutFile $ExePath
Copy-Item -Path $ExePath -Destination "$BinDir\\hf-list.exe" -Force
Copy-Item -Path $ExePath -Destination "$BinDir\\hf-mount.exe" -Force
if (!(($env:Path -split ';') -contains $BinDir)) {
    [System.Environment]::SetEnvironmentVariable("Path", $env:Path + ";$BinDir", "User")
    $env:Path += ";$BinDir"
    Write-Host "Added $BinDir to PATH. You may need to restart your terminal." -ForegroundColor Yellow
}
$ConfigDir = "$HOME\\.config\\hf-save"
if (!(Test-Path $ConfigDir)) { New-Item -ItemType Directory -Force -Path $ConfigDir }
if ($Token -eq "") {
    if ($env:HF_SAVE_API_KEY -ne $null) {
        $Token = $env:HF_SAVE_API_KEY
    } elseif ([Environment]::UserInteractive) {
        $Token = Read-Host "Enter your HF_SAVE_API_KEY (Pre-shared API Key)"
    }
}
$Config = @{
    server_url = $ServerUrl
    api_key = $Token
} | ConvertTo-Json
$Config | Out-File -FilePath "$ConfigDir\\config.json" -Encoding utf8
Write-Host "Installation successful! Try running: hf-save --help" -ForegroundColor Green
`;
    return c.text(script, 200, { "Content-Type": "text/plain" });
  }

  // Linux / macOS script
  const script = `#!/bin/bash
set -e
SERVER_URL="${serverUrl}"
TOKEN="${token}"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ARCH="amd64"
UNAME_M="$(uname -m)"
if [[ "$UNAME_M" == "arm64" || "$UNAME_M" == "aarch64" ]]; then
    ARCH="arm64"
fi
PLATFORM="linux"
if [[ "$(uname)" == "Darwin" ]]; then
    PLATFORM="darwin"
fi
echo "Downloading hf-save CLI for $PLATFORM ($ARCH)..."
curl -fsSL "$SERVER_URL/bin/\${PLATFORM}-\${ARCH}" -o "$BIN_DIR/hf-save"
chmod +x "$BIN_DIR/hf-save"
ln -sf hf-save "$BIN_DIR/hf-list"
ln -sf hf-save "$BIN_DIR/hf-mount"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo "Adding $BIN_DIR to PATH in shell profile..."
    if [[ "$SHELL" == */zsh ]]; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
    else
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    fi
    export PATH="$BIN_DIR:$PATH"
fi

CONFIG_DIR="$HOME/.config/hf-save"
mkdir -p "$CONFIG_DIR"
if [ -z "$TOKEN" ]; then
    if [ -n "$HF_SAVE_API_KEY" ]; then
        TOKEN="$HF_SAVE_API_KEY"
    elif [ -t 0 ]; then
        read -p "Enter your HF_SAVE_API_KEY: " TOKEN
    fi
fi
cat << EOF > "$CONFIG_DIR/config.json"
{
  "server_url": "$SERVER_URL",
  "api_key": "$TOKEN"
}
EOF
echo "Installation successful! Try running: hf-save --help"
`;
  return c.text(script, 200, { "Content-Type": "text/plain" });
});

// Serve Binaries via GitHub Release redirect
app.get("/bin/:platform", async (c) => {
  const target = c.req.param("platform");
  const repo = c.env.GITHUB_REPO;

  if (repo) {
    const releaseUrl = `https://github.com/${repo}/releases/latest/download/${target}`;
    return c.redirect(releaseUrl);
  }

  return c.text(
    `Binary download endpoint for '${target}'. Please set GITHUB_REPO secret in Cloudflare Worker (e.g. wrangler secret put GITHUB_REPO => 'your-username/hf-save').`,
    404
  );
});

// Upload Intent Handshake
app.post("/upload-intent", async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: "Unauthorized: Invalid or missing API Key" }, 401);
  }

  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME;

  if (tokens.length === 0 || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    await withHfRetry(tokens, async (token) => {
      return await createRepo({
        repo: { type: "dataset", name: bucketName },
        accessToken: token,
      });
    });
  } catch (e: any) {
    // Ignore if repository already exists
  }

  return c.json({
    success: true,
    bucket: bucketName,
    endpoint: `https://s3.hf.co`,
    direct_s3_supported: true,
  });
});

// File Upload Proxy (Uploads individual file to HF Dataset/Bucket with auto repo creation)
app.post("/upload", async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: "Unauthorized: Invalid or missing API Key" }, 401);
  }

  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME;

  if (tokens.length === 0 || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  const filePath = c.req.query("path");
  if (!filePath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  try {
    const arrayBuffer = await c.req.arrayBuffer();
    const blob = new Blob([arrayBuffer]);

    await withHfRetry(tokens, async (token) => {
      try {
        return await uploadFile({
          repo: { type: "dataset", name: bucketName },
          accessToken: token,
          file: {
            path: filePath,
            content: blob,
          },
        });
      } catch (err: any) {
        const errMsg = String(err.message || err);
        if (errMsg.includes("404") || errMsg.toLowerCase().includes("not found")) {
          // Auto-create dataset repository if it doesn't exist yet
          try {
            await createRepo({
              repo: { type: "dataset", name: bucketName },
              accessToken: token,
            });
          } catch (_) {}
          return await uploadFile({
            repo: { type: "dataset", name: bucketName },
            accessToken: token,
            file: {
              path: filePath,
              content: blob,
            },
          });
        }
        throw err;
      }
    });

    return c.json({ success: true, path: filePath });
  } catch (e: any) {
    return c.json({ error: e.message || "Upload failed" }, 500);
  }
});

// Bucket Statistics & Metadata KPI Endpoint
app.get("/stats", async (c) => {
  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME || "Not Configured";

  if (tokens.length === 0 || !c.env.HF_BUCKET_NAME) {
    return c.json({
      bucket_name: bucketName,
      total_size_bytes: 0,
      total_files: 0,
      total_runs: 0,
      token_count: tokens.length,
      status: "Secrets Missing",
    });
  }

  let totalSize = 0;
  let totalFiles = 0;
  const runs = new Set<string>();
  let isNotFound = false;

  try {
    await withHfRetry(tokens, async (token) => {
      totalSize = 0;
      totalFiles = 0;
      runs.clear();

      try {
        const filesIterable = listFiles({
          repo: { type: "dataset", name: bucketName },
          accessToken: token,
          recursive: true,
        });

        for await (const file of filesIterable) {
          totalFiles++;
          totalSize += file.size || 0;
          const parts = file.path.split("/");
          if (parts.length >= 2) {
            runs.add(`${parts[0]}/${parts[1]}`);
          } else if (parts.length === 1) {
            runs.add(parts[0]);
          }
        }
      } catch (listErr: any) {
        const msg = String(listErr.message || listErr);
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          isNotFound = true;
        } else {
          throw listErr;
        }
      }
    });

    return c.json({
      bucket_name: bucketName,
      total_size_bytes: totalSize,
      total_files: totalFiles,
      total_runs: runs.size,
      token_count: tokens.length,
      status: isNotFound ? "Connected (Empty Repo)" : "Connected",
    });
  } catch (e: any) {
    return c.json({
      bucket_name: bucketName,
      total_size_bytes: 0,
      total_files: 0,
      total_runs: 0,
      token_count: tokens.length,
      status: "Error",
      error: e.message,
    });
  }
});

// List Files & Directories
app.get("/list", async (c) => {
  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME;
  const subPath = c.req.query("path") || c.req.query("date") || "";

  if (tokens.length === 0 || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    const items: Array<{ name: string; is_dir: boolean; size: number; time: string }> = [];

    await withHfRetry(tokens, async (token) => {
      try {
        const filesIterable = listFiles({
          repo: { type: "dataset", name: bucketName },
          accessToken: token,
          path: subPath,
          recursive: true,
        });

        const seenDirs = new Set<string>();
        const nowIso = new Date().toISOString();
        items.length = 0;

        for await (const file of filesIterable) {
          const relPath = subPath ? file.path.substring(subPath.length).replace(/^\//, "") : file.path;
          if (!relPath) continue;

          const parts = relPath.split("/");
          if (parts.length > 1) {
            const dirName = parts[0];
            if (!seenDirs.has(dirName)) {
              seenDirs.add(dirName);
              items.push({
                name: dirName,
                is_dir: true,
                size: 0,
                time: nowIso,
              });
            }
          } else {
            items.push({
              name: parts[0],
              is_dir: false,
              size: file.size || 0,
              time: nowIso,
            });
          }
        }
      } catch (listErr: any) {
        const msg = String(listErr.message || listErr);
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          // Repo not created yet or path doesn't exist
          items.length = 0;
          return;
        }
        throw listErr;
      }
    });

    return c.json(items);
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to list files" }, 500);
  }
});

// Download File
app.get("/download", async (c) => {
  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME;
  const filePath = c.req.query("path");

  if (!filePath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  if (tokens.length === 0 || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  const directUrl = `https://huggingface.co/datasets/${bucketName}/resolve/main/${encodeURIComponent(filePath)}`;
  return c.redirect(directUrl);
});

// Delete Files / Directories
app.all("/delete", async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: "Unauthorized: Invalid or missing API Key" }, 401);
  }

  const tokens = parseTokens(c.env.HF_TOKEN);
  const bucketName = c.env.HF_BUCKET_NAME;
  const targetPath = c.req.query("path") || c.req.query("date");

  if (!targetPath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  if (tokens.length === 0 || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    let count = 0;
    await withHfRetry(tokens, async (token) => {
      const filesIterable = listFiles({
        repo: { type: "dataset", name: bucketName },
        accessToken: token,
        path: targetPath,
        recursive: true,
      });

      count = 0;
      for await (const file of filesIterable) {
        await deleteFile({
          repo: { type: "dataset", name: bucketName },
          accessToken: token,
          path: file.path,
        });
        count++;
      }
    });

    return c.json({ success: true, deleted_count: count });
  } catch (e: any) {
    return c.json({ error: e.message || "Delete failed" }, 500);
  }
});

// Web UI Dashboard
app.get("/", (c) => {
  const host = c.req.header("host") || "localhost";
  const protocol = c.req.header("x-forwarded-proto") || "https";
  const serverUrl = `${protocol}://${host}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>hf-save | Storage Dashboard & Metrics</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 26, 44, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.35);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --mono-font: 'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(12px);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
      font-size: 1.25rem;
      color: #fff;
    }
    .logo-badge {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      font-size: 0.8rem;
    }
    main {
      flex: 1;
      padding: 2rem;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
    }
    .hero {
      margin-bottom: 2rem;
    }
    .hero h1 { font-size: 1.8rem; font-weight: 600; margin-bottom: 0.5rem; }
    .hero p { color: var(--text-muted); font-size: 0.95rem; }
    
    .installer-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      backdrop-filter: blur(8px);
    }
    .installer-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 1.2rem;
    }
    .input-label {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .text-input {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 0.6rem 1rem;
      color: #fff;
      font-family: var(--mono-font);
      font-size: 0.9rem;
      width: 100%;
      outline: none;
      transition: border-color 0.2s;
    }
    .text-input:focus {
      border-color: var(--accent);
    }
    .tab-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.8rem;
    }
    .tab-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 0.4rem 0.9rem;
      border-radius: 6px;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .cmd-box {
      background: #04060a;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 1rem 1.2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      font-family: var(--mono-font);
      font-size: 0.88rem;
      color: #38bdf8;
      overflow-x: auto;
    }
    .copy-btn {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #fff;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .copy-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.5rem;
      backdrop-filter: blur(8px);
    }
    .card-title { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card-val { font-size: 1.6rem; font-weight: 700; font-family: var(--mono-font); overflow: hidden; text-overflow: ellipsis; }
    .card-sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.4rem; }

    .explorer {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
    }
    .explorer-header {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .explorer-title { font-weight: 600; }
    .file-list { list-style: none; }
    .file-item {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.2s;
    }
    .file-item:hover { background: rgba(255, 255, 255, 0.03); }
    .file-name { display: flex; align-items: center; gap: 0.75rem; font-family: var(--mono-font); font-size: 0.9rem; }
    .btn {
      background: var(--accent);
      color: #fff;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <span>💾 hf-save</span>
      <span class="logo-badge">Cloudflare Worker</span>
    </div>
  </header>
  <main>
    <section class="hero">
      <h1>Snapshot Storage Explorer</h1>
      <p>Ephemeral GPU developer backup & restore backend powered by Cloudflare Workers and Hugging Face Buckets.</p>
    </section>

    <!-- KPI / Metrics Grid -->
    <div class="grid">
      <div class="card">
        <div class="card-title">Connected Bucket</div>
        <div class="card-val" id="kpiBucket" style="color: #818cf8; font-size: 1.2rem;">Loading...</div>
        <div class="card-sub" id="kpiBucketSub">Hugging Face Storage</div>
      </div>
      <div class="card">
        <div class="card-title">Total Storage Used</div>
        <div class="card-val" id="kpiSize" style="color: #34d399;">...</div>
        <div class="card-sub">Chunk deduplicated (Xet)</div>
      </div>
      <div class="card">
        <div class="card-title">Snapshot Runs</div>
        <div class="card-val" id="kpiRuns" style="color: #f472b6;">...</div>
        <div class="card-sub">Active backup sessions</div>
      </div>
      <div class="card">
        <div class="card-title">Total Files</div>
        <div class="card-val" id="kpiFiles" style="color: #fbbf24;">...</div>
        <div class="card-sub">Unarchived objects</div>
      </div>
      <div class="card">
        <div class="card-title">Token Pool</div>
        <div class="card-val" id="kpiTokens" style="color: #a78bfa;">...</div>
        <div class="card-sub">Account failover pool</div>
      </div>
    </div>

    <!-- CLI Quick Installer Section -->
    <div class="installer-box">
      <div class="installer-title">
        <span>⚡ Quick CLI Installation Generator</span>
      </div>
      <div class="input-group">
        <label class="input-label" for="keyInput">API Key (HF_SAVE_API_KEY):</label>
        <input type="text" id="keyInput" class="text-input" placeholder="Enter pre-shared API key (or leave empty)" oninput="updateCmd()" />
      </div>

      <div class="tab-bar">
        <button class="tab-btn active" id="tabLinux" onclick="setPlatform('linux')">🐧 Linux (bash)</button>
        <button class="tab-btn" id="tabMac" onclick="setPlatform('mac')">🍎 macOS (zsh/bash)</button>
        <button class="tab-btn" id="tabWin" onclick="setPlatform('windows')">🪟 Windows (PowerShell)</button>
      </div>

      <div class="cmd-box">
        <code id="cmdText">curl -fsSL "${serverUrl}/init?platform=linux&token=" | bash</code>
        <button class="copy-btn" onclick="copyCmd()">Copy Command</button>
      </div>
    </div>

    <div class="explorer">
      <div class="explorer-header">
        <span class="explorer-title">Remote Snapshots & Backups</span>
      </div>
      <ul class="file-list" id="files">
        <li class="file-item">
          <div class="file-name">Fetching snapshots from Hugging Face Bucket...</div>
        </li>
      </ul>
    </div>
  </main>

  <script>
    const serverUrl = "${serverUrl}";
    let currentPlatform = 'linux';

    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function setPlatform(p) {
      currentPlatform = p;
      document.getElementById('tabLinux').classList.toggle('active', p === 'linux');
      document.getElementById('tabMac').classList.toggle('active', p === 'mac');
      document.getElementById('tabWin').classList.toggle('active', p === 'windows');
      updateCmd();
    }

    function updateCmd() {
      const key = encodeURIComponent(document.getElementById('keyInput').value.trim());
      const cmdEl = document.getElementById('cmdText');

      if (currentPlatform === 'windows') {
        cmdEl.innerText = \`irm "\${serverUrl}/init?platform=windows&token=\${key}" | iex\`;
      } else if (currentPlatform === 'mac') {
        cmdEl.innerText = \`curl -fsSL "\${serverUrl}/init?platform=mac&token=\${key}" | bash\`;
      } else {
        cmdEl.innerText = \`curl -fsSL "\${serverUrl}/init?platform=linux&token=\${key}" | bash\`;
      }
    }

    function copyCmd() {
      const cmd = document.getElementById('cmdText').innerText;
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.innerText = 'Copied!';
        setTimeout(() => btn.innerText = 'Copy Command', 2000);
      });
    }

    async function loadStats() {
      try {
        const res = await fetch('/stats');
        const data = await res.json();
        
        const bucketEl = document.getElementById('kpiBucket');
        if (data.error) {
          bucketEl.innerText = data.bucket_name || 'Error';
          document.getElementById('kpiBucketSub').innerText = \`Error: \${data.error}\`;
        } else {
          bucketEl.innerHTML = \`<a href="https://huggingface.co/datasets/\${data.bucket_name}" target="_blank" style="color:inherit; text-decoration:underline;">\${data.bucket_name}</a>\`;
          document.getElementById('kpiBucketSub').innerText = \`Status: \${data.status || 'Connected'}\`;
        }
        
        document.getElementById('kpiSize').innerText = formatBytes(data.total_size_bytes);
        document.getElementById('kpiRuns').innerText = data.total_runs || 0;
        document.getElementById('kpiFiles').innerText = data.total_files || 0;
        document.getElementById('kpiTokens').innerText = \`\${data.token_count || 1} Account\${(data.token_count > 1 ? 's' : '')}\`;
      } catch (e) {
        document.getElementById('kpiBucket').innerText = 'Error';
      }
    }

    async function loadFiles() {
      try {
        const res = await fetch('/list');
        const data = await res.json();
        const listEl = document.getElementById('files');
        if (!Array.isArray(data) || data.length === 0) {
          listEl.innerHTML = '<li class="file-item"><div class="file-name">No snapshot runs found in bucket.</div></li>';
          return;
        }
        listEl.innerHTML = data.map(item => \`
          <li class="file-item">
            <div class="file-name">
              <span>\${item.is_dir ? '📁' : '📄'}</span>
              <span>\${item.name}</span>
            </div>
            <a class="btn" href="/download?path=\${encodeURIComponent(item.name)}" target="_blank">\${item.is_dir ? 'Explore' : 'Download'}</a>
          </li>
        \`).join('');
      } catch (e) {
        document.getElementById('files').innerHTML = '<li class="file-item"><div class="file-name">Failed to load snapshots.</div></li>';
      }
    }

    loadStats();
    loadFiles();
  </script>
</body>
</html>`;
  return c.html(html);
});

export default app;
