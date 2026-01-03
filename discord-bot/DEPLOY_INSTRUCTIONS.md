# Deployment Instructions (Linode / Docker)

## 1. Prerequisites
- Docker installed on the Linode server.
- Git installed.
- `.env` file with your production keys (Discord Token, Gemini Key, etc.).

## 2. Deployment Steps

### Option A: Using the Deployment Script (Recommended)
If you have the `deploy_remote.sh` script set up:

```bash
./deploy_remote.sh
```

### Option B: Manual Deployment

1. **Pull the latest code:**
   ```bash
   cd story_book
   git fetch origin
   git checkout CollectionVersion
   git pull origin CollectionVersion
   ```

2. **Navigate to the bot directory:**
   ```bash
   cd discord-bot
   ```

3. **Build the Docker Image:**
   ```bash
   docker build -t tournament-bot .
   ```

4. **Stop and Remove Old Container:**
   ```bash
   docker stop tournament-bot || true
   docker rm tournament-bot || true
   ```

5. **Run the New Container:**
   *Make sure your `.env` file is present in the `discord-bot` directory.*
   
   ```bash
   docker run -d \
     --name tournament-bot \
     --restart unless-stopped \
     --env-file .env \
     -v $(pwd)/data:/app/data \
     tournament-bot
   ```

## 3. Verification
Check the logs to ensure the bot started correctly:
```bash
docker logs -f tournament-bot
```
