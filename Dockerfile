# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY tests ./tests
COPY app.js ./app.js
RUN npm test
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "route-api"]
