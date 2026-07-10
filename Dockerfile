FROM node:24

# Everything the app needs at build AND run time — this image must be fully
# self-sufficient since the host (a bare Proxmox LXC) has nothing preinstalled:
#   ffmpeg            resamples go-librespot's PCM for Discord
#   curl, ca-certs    fetch the go-librespot release binary (install:librespot)
#   python3, make, g++  compile npm's native addons (@discordjs/opus, sodium-native)
# mkfifo (used at runtime for each player's named pipe) ships in coreutils,
# already part of this base image — nothing extra needed for it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      ca-certificates \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run install:librespot
RUN npm run build

CMD ["npm", "start"]
