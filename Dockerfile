FROM ghcr.io/puppeteer/puppeteer:23.4.0

# Switch to root user to install necessary packages
USER root

# Install necessary packages and Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Download and install Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Switch back to the non-root user (puppeteer)
USER pptruser

# Start the application
CMD ["node", "app.js"]
