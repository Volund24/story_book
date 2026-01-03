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
   docker build -t infinite-heroes-bot .
   ```

4. **Stop and Remove Old Container:**
   ```bash
   docker stop infinite-heroes-bot || true
   docker rm infinite-heroes-bot || true
   ```

5. **Run the New Container:**
   *Make sure your `.env` file is present in the `discord-bot` directory.*
   
   ```bash
   docker run -d \
     --name infinite-heroes-bot \
     --restart unless-stopped \
     --env-file .env \
     -v $(pwd)/data:/app/data \
     infinite-heroes-bot
   ```

## 3. Verification
Check the logs to ensure the bot started correctly:
```bash
docker logs -f infinite-heroes-bot
```
