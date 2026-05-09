#!/bin/bash
# Build Docker image for tiny-cli

echo "🐳 Building Docker image for tiny-cli..."
docker build -t tiny-cli:latest .

if [ $? -eq 0 ]; then
  echo "✅ Docker image 'tiny-cli:latest' built successfully!"
  echo "You can now run: docker-compose up"
else
  echo "❌ Error: Docker image build failed."
  exit 1
fi
