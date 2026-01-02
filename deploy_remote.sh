#!/bin/bash
set -e

echo "🚀 Starting Remote Deployment..."

# Define variables
REPO_URL="https://github.com/Volund24/story_book.git"
APP_DIR="story_book"
BOT_DIR="discord-bot"
CONTAINER_NAME="infinite-heroes-bot"

# 1. Setup Directory
if [ -d "$APP_DIR" ]; then
    echo "📂 Directory exists. Pulling latest changes..."
    cd $APP_DIR
    git pull origin main
else
    echo "📂 Cloning repository..."
    git clone $REPO_URL
    cd $APP_DIR
fi

cd $BOT_DIR

# 2. Create .env file
echo "🔐 Configuring environment..."
cat > .env <<EOF
DISCORD_TOKEN=YOUR_DISCORD_TOKEN
CLIENT_ID=YOUR_CLIENT_ID
GEMINI_KEY=YOUR_GEMINI_KEY
WEB_APP_URL=https://story-book-etoqgyahl-volund24s-projects.vercel.app
DATABASE_URL=postgresql://postgres:svX%24Z%40xkn9zy%24sF@db.fhkfsdirfdritfguevfh.supabase.co:6543/postgres
NODE_OPTIONS='--dns-result-order=ipv4first'
EOF

# 3. Docker Operations
echo "🐳 Building Docker image..."
docker build -t $CONTAINER_NAME .

echo "🛑 Stopping old container (if running)..."
docker stop $CONTAINER_NAME || true
docker rm $CONTAINER_NAME || true

echo "▶️ Starting new container..."
docker run -d \
  --restart always \
  --network host \
  --name $CONTAINER_NAME \
  --env-file .env \
  $CONTAINER_NAME

echo "✅ Deployment Complete! Bot is running."
echo "🐳 Active Containers:"
docker ps
