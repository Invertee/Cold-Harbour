FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8099 DATA_DIR=/data
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data
EXPOSE 8099
EXPOSE 8102
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8099/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
