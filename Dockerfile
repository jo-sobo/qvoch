# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps
COPY web/ ./
RUN npm run build

# Stage 2: Build Backend
FROM golang:1.24-alpine AS backend-builder
ARG BUILD_ID=non-official-unknown-nogit-notime
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=nogit
ARG BUILD_TIME=notime
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend-builder /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build \
	-ldflags="-s -w -X main.serverBuildID=${BUILD_ID} -X main.buildBranch=${BUILD_BRANCH} -X main.buildCommit=${BUILD_COMMIT} -X main.buildTime=${BUILD_TIME}" \
	-o server .

# Stage 3: Final Image
FROM alpine:3.19
ARG BUILD_ID=non-official-unknown-nogit-notime
ENV QVOCH_BUILD_ID=${BUILD_ID}
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=backend-builder /app/server .
COPY --from=backend-builder /app/web/dist ./web/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 17223
EXPOSE 40000-40100/udp
ENTRYPOINT ["./docker-entrypoint.sh"]
