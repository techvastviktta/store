package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	ServerURL string `json:"server_url"`
	APIKey    string `json:"api_key"`
}

type ListItem struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
	Time  string `json:"time"`
}

func main() {
	exeName := filepath.Base(os.Args[0])
	exeName = strings.TrimSuffix(exeName, ".exe")

	var command string
	var cmdArgs []string

	if exeName == "hf-list" {
		command = "list"
		if len(os.Args) > 1 {
			cmdArgs = os.Args[1:]
		}
	} else if exeName == "hf-mount" {
		command = "mount"
		if len(os.Args) > 1 {
			cmdArgs = os.Args[1:]
		} else {
			fmt.Println("Error: Please specify what to restore.")
			os.Exit(1)
		}
	} else {
		if len(os.Args) < 2 {
			printUsageAndExit()
		}

		arg1 := os.Args[1]
		if arg1 == "-h" || arg1 == "--help" || arg1 == "help" {
			printUsageAndExit()
		}

		if arg1 == "save" {
			command = "save"
			cmdArgs = os.Args[2:]
		} else if arg1 == "list" {
			command = "list"
			cmdArgs = os.Args[2:]
		} else if arg1 == "mount" {
			command = "mount"
			cmdArgs = os.Args[2:]
		} else if arg1 == "delete" {
			command = "delete"
			cmdArgs = os.Args[2:]
		} else if arg1 == "status" {
			command = "status"
			cmdArgs = os.Args[2:]
		} else {
			command = "save"
			cmdArgs = os.Args[1:]
		}
	}

	switch command {
	case "save":
		if len(cmdArgs) == 0 {
			fmt.Println("Error: No directories specified to save.")
			os.Exit(1)
		}

		var saveName, saveTag, savePrefix string
		var targets []string
		for i := 0; i < len(cmdArgs); i++ {
			arg := cmdArgs[i]
			if (arg == "-n" || arg == "--name") && i+1 < len(cmdArgs) {
				saveName = cmdArgs[i+1]
				i++
			} else if (arg == "-t" || arg == "--tag") && i+1 < len(cmdArgs) {
				saveTag = cmdArgs[i+1]
				i++
			} else if (arg == "-p" || arg == "--prefix") && i+1 < len(cmdArgs) {
				savePrefix = cmdArgs[i+1]
				i++
			} else if strings.HasPrefix(arg, "-") {
				fmt.Printf("Unknown flag: %s\n", arg)
				printUsageAndExit()
			} else {
				targets = append(targets, arg)
			}
		}

		if len(targets) == 0 {
			fmt.Println("Error: No directories or files specified to save.")
			os.Exit(1)
		}
		runSave(targets, saveName, saveTag, savePrefix)

	case "list":
		runList(cmdArgs)
	case "mount":
		if len(cmdArgs) == 0 {
			fmt.Println("Error: Please specify what to restore.")
			os.Exit(1)
		}

		var outputDir string
		var targets []string
		for i := 0; i < len(cmdArgs); i++ {
			arg := cmdArgs[i]
			if (arg == "-o" || arg == "--output") && i+1 < len(cmdArgs) {
				outputDir = cmdArgs[i+1]
				i++
			} else if strings.HasPrefix(arg, "-") {
				fmt.Printf("Unknown flag: %s\n", arg)
				printUsageAndExit()
			} else {
				targets = append(targets, arg)
			}
		}

		if len(targets) == 0 {
			fmt.Println("Error: Please specify what to restore.")
			os.Exit(1)
		}
		runMount(targets, outputDir)
	case "delete":
		runDelete(cmdArgs)
	case "status":
		runStatus()
	}
}

func printUsageAndExit() {
	fmt.Println(`hf-save: Extremely fast backup/restore tool for ephemeral GPU instances (Cloudflare Worker & HF Bucket Edition)

Usage:
  hf-save <dir1> [dir2]...                     Save directories or files to HF Bucket (implicit save)
  hf-save save [flags] <dir1> [dir2]...        Save directories or files to HF Bucket
  hf-save list                                 List top-level snapshot dates
  hf-save list [date/foldername/subpath]       List folders and files under a path
  hf-save mount [flags] <dir_name>             Restore latest backup containing directory name
  hf-save mount [flags] <date> <run>           Restore specific backup snapshot
  hf-save delete <path_on_server>              Delete a specific backup folder or file
  hf-save status                               Check backend connection & status

Flags for save:
  -n, --name <custom_name>                     Use a custom name for the backup run
  -t, --tag <tag>                              Append an optional version tag
  -p, --prefix <custom_prefix>                 Use a custom root directory instead of the current date

Flags for mount:
  -o, --output <output_dir>                    Specify a custom output folder (defaults to current dir)
`)
	os.Exit(0)
}

func loadConfig() Config {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Printf("Error determining user home directory: %v\n", err)
		os.Exit(1)
	}

	configPath := filepath.Join(home, ".config", "hf-save", "config.json")
	file, err := os.Open(configPath)
	if err != nil {
		fmt.Printf("Error: Configuration file not found at %s. Please run the init script first.\n", configPath)
		os.Exit(1)
	}
	defer file.Close()

	bytes, err := io.ReadAll(file)
	if err != nil {
		fmt.Printf("Error reading configuration: %v\n", err)
		os.Exit(1)
	}

	if len(bytes) >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
		bytes = bytes[3:]
	}

	var cfg Config
	if err := json.Unmarshal(bytes, &cfg); err != nil {
		fmt.Printf("Error parsing configuration: %v\n", err)
		os.Exit(1)
	}

	cfg.ServerURL = strings.TrimSuffix(cfg.ServerURL, "/")
	return cfg
}

func ensureServerAwake(serverURL string) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(serverURL + "/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		fmt.Println("Warning: Could not connect to Cloudflare Worker backend.")
		if resp != nil {
			resp.Body.Close()
		}
		return
	}
	resp.Body.Close()
}

type uploadFile struct {
	relPath string
	absPath string
}

func runSave(targets []string, customName, tag, customPrefix string) {
	cfg := loadConfig()
	ensureServerAwake(cfg.ServerURL)

	for _, target := range targets {
		saveSingleTarget(cfg, target, customName, tag, customPrefix)
	}
}

func saveSingleTarget(cfg Config, target string, customName, tag, customPrefix string) {
	cleanDir := filepath.Clean(target)
	info, err := os.Stat(cleanDir)
	if err != nil {
		fmt.Printf("Error: Target '%s' not found, skipping.\n", target)
		return
	}

	// Handshake: Call /upload-intent to verify Auth and Auto-Create Bucket/Repo
	intentURL := cfg.ServerURL + "/upload-intent"
	intentReq, err := http.NewRequest(http.MethodPost, intentURL, bytes.NewBuffer([]byte("{}")))
	if err == nil {
		if cfg.APIKey != "" {
			intentReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
		client := &http.Client{Timeout: 10 * time.Second}
		intentResp, err := client.Do(intentReq)
		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			return
		}
		body, _ := io.ReadAll(intentResp.Body)
		intentResp.Body.Close()

		if intentResp.StatusCode != http.StatusOK {
			fmt.Printf("Error during upload authorization [HTTP %d]: %s\n", intentResp.StatusCode, string(body))
			return
		}
	}

	var filesToUpload []uploadFile
	if !info.IsDir() {
		filesToUpload = append(filesToUpload, uploadFile{
			relPath: filepath.Base(cleanDir),
			absPath: cleanDir,
		})
	} else {
		err = filepath.Walk(cleanDir, func(path string, fileInfo os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if fileInfo.IsDir() {
				return nil
			}

			parts := strings.Split(path, string(filepath.Separator))
			for _, part := range parts {
				if part == ".git" || part == "node_modules" || part == "__pycache__" || part == ".venv" || part == "venv" {
					return nil
				}
			}

			rel, err := filepath.Rel(filepath.Dir(cleanDir), path)
			if err == nil {
				filesToUpload = append(filesToUpload, uploadFile{
					relPath: filepath.ToSlash(rel),
					absPath: path,
				})
			}
			return nil
		})
		if err != nil {
			fmt.Printf("Error scanning target %s: %v\n", target, err)
			return
		}
	}

	if len(filesToUpload) == 0 {
		fmt.Printf("No files found to save in target %s.\n", target)
		return
	}

	istLocation := time.FixedZone("IST", 19800)
	dateStr := time.Now().In(istLocation).Format("2006-01-02")
	timeStr := time.Now().In(istLocation).Format("15-04-05")
	folderSuffix := filepath.Base(cleanDir)

	prefixDir := dateStr
	if customPrefix != "" {
		prefixDir = customPrefix
	}

	prefixName := fmt.Sprintf("%s_%s", timeStr, folderSuffix)
	if customName != "" {
		prefixName = customName
	}
	if tag != "" {
		prefixName = fmt.Sprintf("%s_%s", prefixName, tag)
	}

	prefix := fmt.Sprintf("%s/%s", prefixDir, prefixName)

	fmt.Printf("\n--- Saving target: %s (%d files) ---\n", target, len(filesToUpload))
	fmt.Printf("Uploading snapshot run: %s\n", prefix)

	uploadedCount := 0
	for i, file := range filesToUpload {
		f, err := os.Open(file.absPath)
		if err != nil {
			fmt.Printf("\nFailed to open %s: %v\n", file.absPath, err)
			continue
		}

		targetPath := fmt.Sprintf("%s/%s", prefix, file.relPath)
		reqURL := fmt.Sprintf("%s/upload?path=%s", cfg.ServerURL, url.QueryEscape(targetPath))

		req, err := http.NewRequest(http.MethodPost, reqURL, f)
		if err != nil {
			f.Close()
			continue
		}

		if cfg.APIKey != "" {
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", cfg.APIKey))
		}

		client := &http.Client{Timeout: 60 * time.Second}
		resp, err := client.Do(req)
		f.Close()

		if err != nil {
			fmt.Printf("\nUpload error for %s: %v\n", file.relPath, err)
		} else if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
			resp.Body.Close()
			uploadedCount++
			fmt.Printf("Uploading [%d/%d]: %s\r", i+1, len(filesToUpload), file.relPath)
		} else {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			fmt.Printf("\nUpload failed for %s [HTTP %d]: %s\n", file.relPath, resp.StatusCode, string(body))
		}
	}
	fmt.Printf("\nSuccessfully saved %s! (%d/%d files uploaded)\n", target, uploadedCount, len(filesToUpload))
}

func runList(args []string) {
	cfg := loadConfig()
	subPath := strings.Join(args, "/")

	reqURL := fmt.Sprintf("%s/list", cfg.ServerURL)
	if subPath != "" {
		reqURL += "?path=" + url.QueryEscape(subPath)
	}

	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		fmt.Printf("Failed to create list request: %v\n", err)
		os.Exit(1)
	}
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		fmt.Printf("Request failed [HTTP %d]: %s\n", resp.StatusCode, string(body))
		os.Exit(1)
	}

	var results []ListItem
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		fmt.Printf("Failed to decode response: %v\n", err)
		os.Exit(1)
	}

	if len(results) == 0 {
		fmt.Println("No backups or files found under this path.")
		return
	}

	fmt.Printf("%-6s   %-12s   %-20s   %s\n", "Type", "Size", "Modified Time", "Name")
	fmt.Println(strings.Repeat("-", 80))
	for _, item := range results {
		tStr := "FILE"
		if item.IsDir {
			tStr = "DIR"
		}
		sizeStr := "-"
		if !item.IsDir {
			sizeStr = formatSize(item.Size)
		}
		fmt.Printf("%-6s   %-12s   %-20s   %s\n", tStr, sizeStr, item.Time, item.Name)
	}
}

func runMount(args []string, outputDir string) {
	cfg := loadConfig()
	subPath := strings.Join(args, "/")

	reqURL := fmt.Sprintf("%s/list?path=%s", cfg.ServerURL, url.QueryEscape(subPath))
	resp, err := http.Get(reqURL)
	if err != nil {
		fmt.Printf("Mount failed to list files: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	var items []ListItem
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil || len(items) == 0 {
		fmt.Printf("No files found to restore under %s\n", subPath)
		os.Exit(1)
	}

	fmt.Printf("Restoring snapshot: %s (%d items)\n", subPath, len(items))

	var wg sync.WaitGroup
	semaphore := make(chan struct{}, 4)

	for _, item := range items {
		if item.IsDir {
			continue
		}

		wg.Add(1)
		go func(it ListItem) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			fileUrl := fmt.Sprintf("%s/download?path=%s", cfg.ServerURL, url.QueryEscape(subPath+"/"+it.Name))
			fileResp, err := http.Get(fileUrl)
			if err != nil || fileResp.StatusCode != http.StatusOK {
				if fileResp != nil {
					fileResp.Body.Close()
				}
				return
			}

			localPath := it.Name
			if outputDir != "" {
				localPath = filepath.Join(outputDir, localPath)
			}

			_ = os.MkdirAll(filepath.Dir(localPath), 0755)
			out, err := os.Create(localPath)
			if err != nil {
				fileResp.Body.Close()
				return
			}

			_, _ = io.Copy(out, fileResp.Body)
			out.Close()
			fileResp.Body.Close()
			fmt.Printf("Restored: %s\n", localPath)
		}(item)
	}

	wg.Wait()
	fmt.Println("Restore completed successfully!")
}

func fetchList(serverURL, date string) ([]string, error) {
	reqURL := fmt.Sprintf("%s/list", serverURL)
	if date != "" {
		reqURL += "?path=" + url.QueryEscape(date)
	}

	resp, err := http.Get(reqURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %s", resp.Status)
	}

	var items []ListItem
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return nil, err
	}

	var names []string
	for _, item := range items {
		names = append(names, item.Name)
	}
	return names, nil
}

func runDelete(args []string) {
	if len(args) == 0 {
		fmt.Println("Error: No path specified to delete.")
		os.Exit(1)
	}
	cfg := loadConfig()

	path := strings.Join(args, "/")
	reqURL := fmt.Sprintf("%s/delete?path=%s", cfg.ServerURL, url.QueryEscape(path))
	req, err := http.NewRequest(http.MethodPost, reqURL, nil)
	if err != nil {
		fmt.Printf("Failed to create request: %v\n", err)
		os.Exit(1)
	}
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Delete request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	fmt.Println("Delete requested successfully.")
}

func runStatus() {
	cfg := loadConfig()
	fmt.Printf("Server URL: %s\n", cfg.ServerURL)
	if cfg.APIKey != "" {
		fmt.Println("API Key: Configured")
	} else {
		fmt.Println("API Key: None")
	}
}

func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}
