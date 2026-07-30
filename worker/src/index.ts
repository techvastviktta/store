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
    return c.json({ error: "Unauthorized" }, 401);
  }

  const hfToken = c.env.HF_TOKEN;
  const bucketName = c.env.HF_BUCKET_NAME;

  if (!hfToken || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    await createRepo({
      repo: { type: "dataset", name: bucketName },
      accessToken: hfToken,
    });
  } catch (e: any) {
    // Ignore error if dataset repository already exists
  }

  return c.json({
    success: true,
    bucket: bucketName,
    endpoint: `https://s3.hf.co`,
    direct_s3_supported: true,
  });
});

// File Upload Proxy (Uploads individual file to HF Dataset/Bucket)
app.post("/upload", async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const hfToken = c.env.HF_TOKEN;
  const bucketName = c.env.HF_BUCKET_NAME;

  if (!hfToken || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  const filePath = c.req.query("path");
  if (!filePath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  try {
    const arrayBuffer = await c.req.arrayBuffer();
    const blob = new Blob([arrayBuffer]);

    await uploadFile({
      repo: { type: "dataset", name: bucketName },
      accessToken: hfToken,
      file: {
        path: filePath,
        content: blob,
      },
    });

    return c.json({ success: true, path: filePath });
  } catch (e: any) {
    return c.json({ error: e.message || "Upload failed" }, 500);
  }
});

// List Files & Directories
app.get("/list", async (c) => {
  const hfToken = c.env.HF_TOKEN;
  const bucketName = c.env.HF_BUCKET_NAME;
  const subPath = c.req.query("path") || c.req.query("date") || "";

  if (!hfToken || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    const filesIterable = listFiles({
      repo: { type: "dataset", name: bucketName },
      accessToken: hfToken,
      path: subPath,
      recursive: true,
    });

    const items: Array<{ name: string; is_dir: boolean; size: number; time: string }> = [];
    const seenDirs = new Set<string>();
    const nowIso = new Date().toISOString();

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

    return c.json(items);
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to list files" }, 500);
  }
});

// Download File
app.get("/download", async (c) => {
  const hfToken = c.env.HF_TOKEN;
  const bucketName = c.env.HF_BUCKET_NAME;
  const filePath = c.req.query("path");

  if (!filePath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  if (!hfToken || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  const directUrl = `https://huggingface.co/datasets/${bucketName}/resolve/main/${encodeURIComponent(filePath)}`;
  return c.redirect(directUrl);
});

// Delete Files / Directories
app.all("/delete", async (c) => {
  if (!checkAuth(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const hfToken = c.env.HF_TOKEN;
  const bucketName = c.env.HF_BUCKET_NAME;
  const targetPath = c.req.query("path") || c.req.query("date");

  if (!targetPath) {
    return c.json({ error: "Missing path parameter" }, 400);
  }

  if (!hfToken || !bucketName) {
    return c.json({ error: "Server missing HF_TOKEN or HF_BUCKET_NAME secret" }, 500);
  }

  try {
    const filesIterable = listFiles({
      repo: { type: "dataset", name: bucketName },
      accessToken: hfToken,
      path: targetPath,
      recursive: true,
    });

    let count = 0;
    for await (const file of filesIterable) {
      await deleteFile({
        repo: { type: "dataset", name: bucketName },
        accessToken: hfToken,
        path: file.path,
      });
      count++;
    }

    return c.json({ success: true, deleted_count: count });
  } catch (e: any) {
    return c.json({ error: e.message || "Delete failed" }, 500);
  }
});

// Web UI Dashboard
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>hf-save | Storage Dashboard</title>
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
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
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
    .card-val { font-size: 1.8rem; font-weight: 700; font-family: var(--mono-font); }
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
    <div class="grid">
      <div class="card">
        <div class="card-title">Backend Provider</div>
        <div class="card-val" style="color: #818cf8;">HF Storage</div>
      </div>
      <div class="card">
        <div class="card-title">Edge Runtime</div>
        <div class="card-val" style="color: #34d399;">Cloudflare Worker</div>
      </div>
      <div class="card">
        <div class="card-title">Client CLI</div>
        <div class="card-val" style="color: #f472b6;">Go</div>
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
    loadFiles();
  </script>
</body>
</html>`;
  return c.html(html);
});

export default app;
