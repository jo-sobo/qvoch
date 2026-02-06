# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
ARG VITE_GIPHY_API_KEY=""
ENV VITE_GIPHY_API_KEY=$VITE_GIPHY_API_KEY
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps
COPY web/ ./
RUN npm run build

# Stage 2: Build Backend
FROM golang:1.24-alpine AS backend-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend-builder /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Stage 3: Final Image
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=backend-builder /app/server .
COPY --from=backend-builder /app/web/dist ./web/dist
EXPOSE 17223
EXPOSE 40000-40100/udp
ENTRYPOINT ["./server"]
