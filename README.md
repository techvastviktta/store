# hf-save

An ultra-fast, zero-overhead developer tool to save work artifacts from ephemeral GPU instances (RunPod, Vast.ai, Lambda Labs) and restore them later. 

Uses a **Cloudflare Worker** (built with **npm** and **Hono**) as the control plane and edge web server, connected to a **Hugging Face Bucket** as the backend storage layer, with a single-binary **Go CLI** on the client side.

---

## 🚀 Deploying the Cloudflare Worker Backend

1. Navigate to the `worker/` directory and install dependencies with **npm**:
   ```bash
   cd worker
   npm install
   ```

2. Configure secrets using **Wrangler**:
   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put HF_BUCKET_NAME
   npx wrangler secret put HF_SAVE_API_KEY
   ```
   * `AWS_ACCESS_KEY_ID`: Your Hugging Face S3 Access Key ID (starts with `HFAK...`, supports comma-separated list for multi-account failover).
   * `AWS_SECRET_ACCESS_KEY`: Your Hugging Face S3 Secret Access Key (supports comma-separated list).
   * `HF_BUCKET_NAME`: Target Hugging Face Storage Bucket name (e.g., `xatto/store`).
   * `HF_SAVE_API_KEY`: Secret pre-shared key to authenticate CLI uploads.

3. Deploy the Worker to Cloudflare:
   ```bash
   npm run deploy
   ```

---

## 💻 Client Installation

To install the client binary on any GPU instance or development machine, run the appropriate command. 

### Linux:
```bash
curl -fsSL "https://<your-worker-subdomain>.workers.dev/init?platform=linux&token=<YOUR_KEY>" | bash
```

### Windows (PowerShell):
```powershell
irm "https://<your-worker-subdomain>.workers.dev/init?platform=windows&token=<YOUR_KEY>" | iex
```

### macOS:
```bash
curl -fsSL "https://<your-worker-subdomain>.workers.dev/init?platform=mac&token=<YOUR_KEY>" | bash
```

---

## 🛠️ CLI Usage Guide

All operations are run through the single `hf-save` CLI command.

### 1. Saving Directories or Files (Backups)

Save one or multiple directories/files at once directly to your remote Hugging Face Bucket:

* **Implicit Save**:
  ```bash
  hf-save outputs logs checkpoints
  ```
  *Saves directories `outputs`, `logs`, and `checkpoints` as snapshot runs.*

* **Explicit Save**:
  ```bash
  hf-save save outputs
  ```

---

### 2. Listing Backups & Files

Explore your remote backup storage directly from the CLI or via the **Web Dashboard** (`GET /` on your Cloudflare Worker URL):

* **List Top-Level Dates**:
  ```bash
  hf-save list
  ```

* **List Snapshots for a Path**:
  ```bash
  hf-save list 2026-07-31/18-04-59_outputs
  ```

---

### 3. Restoring Backups (Mounting)

Reconstruct and restore backups directly inside your current working directory:

* **Restore Specific Snapshot**:
  ```bash
  hf-save mount 2026-07-31/18-04-59_outputs
  ```
