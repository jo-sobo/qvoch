package main

import (
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jo-sobo/qvoch/internal/handlers"
	_ "github.com/jo-sobo/qvoch/internal/sfu"
)

const (
	buildTimeLayout        = "20060102-150405"
	buildPrefixNonOfficial = "non-official"
	buildPrefixOfficial    = "official"
)

var (
	// Optional full override supplied via ldflags: -X main.serverBuildID=...
	serverBuildID = ""
	// Recommended ldflags metadata inputs.
	buildBranch = ""
	buildCommit = ""
	buildTime   = ""
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "17223"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handlers.HandleWebSocket)
	mux.Handle("/", http.FileServer(http.Dir("web/dist")))

	var handler http.Handler = mux
	handler = securityHeadersMiddleware(handler)
	handler = sitePassphraseMiddleware(handler)

	addr := fmt.Sprintf(":%s", port)
	log.Printf("QVoCh server starting on %s (build=%s)", addr, resolveServerBuildID())
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

var (
	sitePassphrase string
	authToken      string
)

func init() {
	sitePassphrase = os.Getenv("SITE_PASSPHRASE")
	if sitePassphrase != "" {
		authToken = uuid.New().String()
		log.Printf("Site passphrase enabled — auth required")
	}
}

func resolveServerBuildID() string {
	if override := strings.TrimSpace(serverBuildID); override != "" {
		return normalizeBuildID(override)
	}

	branch := sanitizeBuildToken(buildBranch, "unknown")
	commit := sanitizeCommit(buildCommit)
	timePart := normalizeBuildTime(buildTime)
	dirty := false

	if info, ok := debug.ReadBuildInfo(); ok {
		settings := make(map[string]string, len(info.Settings))
		for _, s := range info.Settings {
			settings[s.Key] = s.Value
		}

		if branch == "unknown" {
			if vcsBranch := sanitizeBuildToken(settings["vcs.branch"], ""); vcsBranch != "" {
				branch = vcsBranch
			}
		}
		if commit == "" {
			commit = sanitizeCommit(settings["vcs.revision"])
		}
		if timePart == "" {
			timePart = normalizeBuildTime(settings["vcs.time"])
		}
		dirty = strings.EqualFold(strings.TrimSpace(settings["vcs.modified"]), "true")
	}

	if commit == "" {
		commit = "nogit"
	}
	if timePart == "" {
		timePart = "notime"
	}

	id := fmt.Sprintf("%s-%s-%s", branch, commit, timePart)
	if dirty {
		id += "-dirty"
	}
	return normalizeBuildID(id)
}

func normalizeBuildID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return buildPrefixNonOfficial + "-unknown-nogit-notime"
	}

	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, buildPrefixOfficial+"-") || strings.HasPrefix(lower, buildPrefixNonOfficial+"-") {
		return raw
	}

	return buildPrefixNonOfficial + "-" + raw
}

func sanitizeBuildToken(raw string, fallback string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return fallback
	}

	var b strings.Builder
	b.Grow(len(raw))
	lastDash := false

	for _, r := range raw {
		if unicode.IsDigit(r) || unicode.IsLetter(r) || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}

	cleaned := strings.Trim(b.String(), "-")
	if cleaned == "" {
		return fallback
	}
	return cleaned
}

func sanitizeCommit(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return ""
	}
	if len(raw) > 12 {
		raw = raw[:12]
	}

	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func normalizeBuildTime(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed.UTC().Format(buildTimeLayout)
	}

	if parsed, err := time.Parse(buildTimeLayout, raw); err == nil {
		return parsed.UTC().Format(buildTimeLayout)
	}

	if unixSec, err := strconv.ParseInt(raw, 10, 64); err == nil && unixSec > 0 {
		return time.Unix(unixSec, 0).UTC().Format(buildTimeLayout)
	}

	return ""
}

func sitePassphraseMiddleware(next http.Handler) http.Handler {
	if sitePassphrase == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth" {
			if r.Method == http.MethodPost {
				handleAuthPost(w, r)
				return
			}
			serveAuthPage(w)
			return
		}

		// SECURITY NOTE: invite links intentionally bypass SITE_PASSPHRASE.
		// The invite token itself acts as authorization. If you require
		// passphrase checks for every access path, remove this bypass block.
		if strings.HasPrefix(r.URL.Path, "/invite/") {
			rest := strings.TrimPrefix(r.URL.Path, "/invite/")
			if rest != "" {
				http.SetCookie(w, &http.Cookie{
					Name:     "qvoch-auth",
					Value:    authToken,
					Path:     "/",
					HttpOnly: true,
					SameSite: http.SameSiteLaxMode,
					MaxAge:   int(30 * 24 * time.Hour / time.Second),
				})
				http.Redirect(w, r, "/#/join/"+rest, http.StatusTemporaryRedirect)
				return
			}
		}

		cookie, err := r.Cookie("qvoch-auth")
		if err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(authToken)) != 1 {
			http.Redirect(w, r, "/auth", http.StatusTemporaryRedirect)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func handleAuthPost(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	submitted := r.FormValue("passphrase")
	if subtle.ConstantTimeCompare([]byte(submitted), []byte(sitePassphrase)) != 1 {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		serveAuthPageWithError(w, "Incorrect passphrase")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "qvoch-auth",
		Value:    authToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(30 * 24 * time.Hour / time.Second),
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func serveAuthPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	serveAuthPageWithError(w, "")
}

func serveAuthPageWithError(w http.ResponseWriter, errorMsg string) {
	errorHTML := ""
	if errorMsg != "" {
		errorHTML = fmt.Sprintf(`<p style="color:#f87171;font-size:14px;margin-bottom:16px">%s</p>`, errorMsg)
	}
	fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QVoCh — Access Required</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111114;color:#e8e8ec;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{width:100%%;max-width:380px;padding:32px}
h1{font-size:28px;font-weight:700;margin-bottom:4px;text-align:center}
.sub{color:#9898a6;font-size:14px;text-align:center;margin-bottom:32px}
label{display:block;font-size:14px;color:#9898a6;margin-bottom:6px}
input{width:100%%;padding:10px 12px;background:#2a2a35;border:1px solid #2a2a38;border-radius:6px;color:#e8e8ec;font-size:14px;outline:none}
input:focus{border-color:#38bdf8}
button{width:100%%;padding:10px;background:#38bdf8;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;margin-top:16px}
button:hover{background:#0ea5e9}
</style>
</head>
<body>
<div class="card">
<h1>QVoCh</h1>
<p class="sub">Enter the site passphrase to continue</p>
%s
<form method="POST" action="/auth">
<label for="passphrase">Passphrase</label>
<input type="password" id="passphrase" name="passphrase" placeholder="Enter passphrase" autofocus required>
<button type="submit">Enter</button>
</form>
</div>
</body>
</html>`, errorHTML)
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' https://media.giphy.com https://media0.giphy.com https://media1.giphy.com https://media2.giphy.com https://media3.giphy.com https://media4.giphy.com data:; "+
				"connect-src 'self' wss: ws: https://api.giphy.com")
		next.ServeHTTP(w, r)
	})
}
