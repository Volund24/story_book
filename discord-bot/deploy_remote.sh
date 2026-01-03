#!/bin/bash
set -e

echo "🚀 Starting Remote Deployment..."

# Define variables
REPO_URL="https://github.com/Volund24/story_book.git"
APP_DIR="story_book"
BOT_DIR="discord-bot"
CONTAINER_NAME="tournament-bot"

# 0. Check Initial Status
echo "📊 Current Container Status:"
docker ps

# 1. Setup Directory
if [ -d "$APP_DIR" ]; then
    echo "📂 Directory exists. Pulling latest changes..."
    cd $APP_DIR
    git fetch origin
    git checkout CollectionVersion
    git pull origin CollectionVersion
else
    echo "📂 Cloning repository..."
    git clone $REPO_URL
    cd $APP_DIR
    git checkout CollectionVersion
fi

cd $BOT_DIR

# 2. Create .env file
echo "🔐 Configuring environment..."
# Note: GEMINI_KEY is set to a placeholder. You must update it manually if not provided!
cat > .env <<ENVEOF
DISCORD_TOKEN=YOUR_DISCORD_TOKEN
CLIENT_ID=YOUR_CLIENT_ID
WEB_APP_URL=https://story-book-etoqgyahl-volund24s-projects.vercel.app
DATABASE_URL=postgresql://postgres:svX%24Z%40xkn9zy%24sF@db.fhkfsdirfdritfguevfh.supabase.co:6543/postgres
NODE_OPTIONS='--dns-result-order=ipv4first'
GEMINI_KEY=PLACEHOLDER_PLEASE_UPDATE
ENVEOF

# 3. Docker Operations
echo "🐳 Building Docker image..."
docker build -t $CONTAINER_NAME .

echo "🛑 Stopping old container (if running)..."
docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true

echo "▶️ Starting new container..."
docker run -d   --restart always   --network host   --name $CONTAINER_NAME   --env-file .env   $CONTAINER_NAME

# 4. Verification
echo "✅ Deployment Complete! Verifying..."
sleep 5

echo "🐳 Active Containers:"
docker ps

if docker ps | grep -q $CONTAINER_NAME; then
    echo "✅ $CONTAINER_NAME is running."
else
    echo "❌ $CONTAINER_NAME failed to start."
    docker logs $CONTAINER_NAME
    exit 1
fi
