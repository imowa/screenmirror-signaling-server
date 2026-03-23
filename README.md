
# ScreenMir Signaling Server

This is the Node.js/Socket.io signaling server and WebRTC matching service for the ScreenMir application. It handles WebRTC offer/answer exchanges, ICE candidates, generic file transfers, and TUS-based large file chunk uploading.

## VPS Deployment Guide (Ubuntu / Debian)

Follow these steps to deploy the signaling server reliably to a Linux VPS.

### 1. Prerequisites

You need Node.js (v18 or newer) and NPM installed on your server.
If they are not installed, run the following commands to install them via NodeSource:

```bash
# Refresh local packages
sudo apt-get update

# Install curl
sudo apt-get install -y ca-certificates curl gnupg

# Add NodeSource repository for Node.js 20.x
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
NODE_MAJOR=20
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

# Update package list and install Node.js
sudo apt-get update
sudo apt-get install -y nodejs

# Verify installation (should output version numbers)
node -v
npm -v
```

### 2. Copy the Files to Your VPS

Upload this `signaling-server` folder to your VPS. You can use SSH/SCP, Git, or an FTP client. We recommend placing it in `/var/www/screenmir-signaling-server` or `/opt/screenmir-signaling-server`.

```bash
# Example if using git
git clone <your-repo-url>
cd screenmir/signaling-server
```

### 3. Install Dependencies

Once you are in the directory containing `package.json`, install the Node modules:

```bash
npm install
```

### 4. Install PM2 for Process Management

To ensure your server stays online if it crashes or the machine restarts, use PM2:

```bash
# Install PM2 globally
sudo npm install pm2 -g
```

### 5. Start the Server with PM2

The default port is `3001`. You can change it by defining `PORT` in an environment variable.

```bash
# Start the server (named "screenmir-signaling")
pm2 start server.js --name "screenmir-signaling"

# Save the PM2 list so it restarts automatically on server reboot
pm2 save
pm2 startup
```
*(Run the command output by `pm2 startup` if it asks you to.)*

### 6. Reverse Proxy with Nginx (Recommended)

To run the server securely under an SSL domain (e.g., `https://5381a0d6-0dde-4fac-8457-c66fcd57919f.svc.dalang.io`), it's highly recommended to place it behind Nginx. 

Install Nginx:
```bash
sudo apt update
sudo apt install nginx
```

Create an Nginx configuration file:
```bash
sudo nano /etc/nginx/sites-available/screenmir-signaling
```

Paste the following configuration (adjusting `server_name` to your actual domain):

```nginx
server {
    listen 80;
    server_name 5381a0d6-0dde-4fac-8457-c66fcd57919f.svc.dalang.io; # Replace with your domain

    # Max upload size configuration for large TUS files (10GB)
    client_max_body_size 10G;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Disable buffering for TUS direct upload progression
        proxy_request_buffering off;
        proxy_buffering off;
        
        # Extended timeouts for large file uploads
        proxy_read_timeout 7200s;
        proxy_connect_timeout 7200s;
        proxy_send_timeout 7200s;
    }
}
```

Enable the configuration and reload Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/screenmir-signaling /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

> **Note on Nginx error `could not build server_names_hash`**: 
> If you get an error that says `could not build server_names_hash, you should increase server_names_hash_bucket_size: 64` when running `sudo nginx -t`, this is because your VPS domain is very long.
> To fix this:
> 1. Edit the main Nginx config: `sudo nano /etc/nginx/nginx.conf`
> 2. Find the `http {` block.
> 3. Uncomment or add the line: `server_names_hash_bucket_size 64;`
> 4. Save the file and run `sudo systemctl restart nginx` again.

### 7. View Logs and Manage

If you need to analyze errors or view logs, use PM2:

```bash
# View active logs
pm2 logs screenmir-signaling

# Restart the service
pm2 restart screenmir-signaling

# Monitor CPU/RAM usage
pm2 monit
```

### Directories Created During Runtime

- `uploads/tus-temp/` - Used during partial TUS chunk uploads.
- `uploads/completed/` - Final location of completed uploads before they are downloaded to the web viewer.
