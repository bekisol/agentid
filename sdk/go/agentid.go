// Package agentid is the official Go SDK for the AgentID Protocol —
// identity layer for AI agents.
//
//	client, _ := agentid.NewClient(agentid.Options{APIKey: "agentid_..."})
//	agent, _  := client.Agents.Create(ctx, agentid.CreateAgentParams{
//	    Name:         "bot",
//	    Capabilities: []string{"chat"},
//	})
package agentid

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// ── Errors ────────────────────────────────────────────────────────────────────

type AgentIDError struct {
	Message string
	Status  int
	Detail  any
}

func (e *AgentIDError) Error() string { return e.Message }

type AuthError      struct{ AgentIDError }
type RateLimitError struct{ AgentIDError }
type NetworkError   struct{ AgentIDError }
type TierError      struct {
	AgentIDError
	CurrentTier  string
	RequiredTier string
	UpgradeURL   string
}

// ── Options + client ──────────────────────────────────────────────────────────

type Options struct {
	APIKey  string
	BaseURL string
	Timeout time.Duration
	HTTP    *http.Client
}

type Client struct {
	apiKey, baseURL string
	http            *http.Client
	owner, tier     string

	Agents              *AgentsResource
	Audit               *AuditResource
	Anomalies           *AnomaliesResource
	Benchmarks          *BenchmarksResource
	Webhooks            *WebhooksResource
	CapabilityContracts *CapabilityContractsResource
}

func NewClient(opts Options) (*Client, error) {
	key := opts.APIKey
	if key == "" { key = os.Getenv("AGENTID_API_KEY") }
	if key == "" { return nil, &AuthError{AgentIDError{Message: "APIKey is required (or AGENTID_API_KEY env)"}} }
	base := strings.TrimRight(opts.BaseURL, "/")
	if base == "" { base = "https://api.agentid-protocol.com" }
	timeout := opts.Timeout
	if timeout == 0 { timeout = 15 * time.Second }
	hc := opts.HTTP
	if hc == nil { hc = &http.Client{Timeout: timeout} }
	c := &Client{apiKey: key, baseURL: base, http: hc}
	c.Agents              = &AgentsResource{c: c}
	c.Audit               = &AuditResource{c: c}
	c.Anomalies           = &AnomaliesResource{c: c}
	c.Benchmarks          = &BenchmarksResource{c: c}
	c.Webhooks            = &WebhooksResource{c: c}
	c.CapabilityContracts = &CapabilityContractsResource{c: c}
	return c, nil
}

// ── Agent type ────────────────────────────────────────────────────────────────

type Agent struct {
	DID            string         `json:"did"`
	Name           string         `json:"name"`
	Owner          string         `json:"owner"`
	PublicKey      string         `json:"public_key"`
	Capabilities   []string       `json:"capabilities"`
	CreatedAt      string         `json:"created_at,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	Private        bool           `json:"private"`
	PrivateKeyB64  string         `json:"-"`
}

type SignedPayload struct {
	Payload   map[string]any `json:"payload"`
	Signature string         `json:"signature"`
}

// Sign signs a payload with the agent's private key. `input` may be a string
// (becomes payload["message"]) or a map.
func (a *Agent) Sign(input any) (SignedPayload, error) {
	if a.PrivateKeyB64 == "" {
		return SignedPayload{}, errors.New("agent has no private key — was it loaded from a remote fetch?")
	}
	priv, err := base64.StdEncoding.DecodeString(a.PrivateKeyB64)
	if err != nil { return SignedPayload{}, fmt.Errorf("decode private key: %w", err) }
	if len(priv) == ed25519.SeedSize {
		priv = ed25519.NewKeyFromSeed(priv)
	}
	var payload map[string]any
	switch v := input.(type) {
	case string:                 payload = map[string]any{"message": v}
	case map[string]any:         payload = clone(v)
	default:                     return SignedPayload{}, errors.New("input must be string or map")
	}
	if _, ok := payload["timestamp"]; !ok { payload["timestamp"] = time.Now().Unix() }
	if _, ok := payload["nonce"];     !ok { payload["nonce"]     = randomHex(16) }
	canonical, err := canonicalJSON(payload)
	if err != nil { return SignedPayload{}, err }
	sig := ed25519.Sign(priv, canonical)
	return SignedPayload{Payload: payload, Signature: base64.StdEncoding.EncodeToString(sig)}, nil
}

func clone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m { out[k] = v }
	return out
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil { panic(err) }
	return hex.EncodeToString(b)
}

// ── Canonical JSON ────────────────────────────────────────────────────────────

// canonicalJSON serialises with sorted keys and minimal separators —
// matches the server's `agentid.crypto._canonical()`.
func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil { return nil, err }
	return buf.Bytes(), nil
}

func writeCanonical(w io.Writer, v any) error {
	switch x := v.(type) {
	case nil:    _, err := io.WriteString(w, "null"); return err
	case bool:
		if x { _, err := io.WriteString(w, "true");  return err }
		_, err := io.WriteString(w, "false"); return err
	case string:
		b, err := json.Marshal(x); if err != nil { return err }
		_, err = w.Write(b); return err
	case float64, float32, int, int32, int64, uint, uint32, uint64, json.Number:
		b, err := json.Marshal(x); if err != nil { return err }
		_, err = w.Write(b); return err
	case []any:
		w.Write([]byte("["))
		for i, e := range x {
			if i > 0 { w.Write([]byte(",")) }
			if err := writeCanonical(w, e); err != nil { return err }
		}
		_, err := w.Write([]byte("]")); return err
	case map[string]any:
		w.Write([]byte("{"))
		keys := make([]string, 0, len(x))
		for k := range x { keys = append(keys, k) }
		sort.Strings(keys)
		for i, k := range keys {
			if i > 0 { w.Write([]byte(",")) }
			kj, _ := json.Marshal(k)
			w.Write(kj)
			w.Write([]byte(":"))
			if err := writeCanonical(w, x[k]); err != nil { return err }
		}
		_, err := w.Write([]byte("}")); return err
	default:
		// Fallback: marshal & re-decode generic types
		b, err := json.Marshal(x)
		if err != nil { return err }
		var generic any
		if err := json.Unmarshal(b, &generic); err != nil { return err }
		return writeCanonical(w, generic)
	}
}

// ── DID derivation ───────────────────────────────────────────────────────────

// publicKeyToDID computes the AgentID DID from a public key, using the
// same base58btc alphabet as the server.
func publicKeyToDID(pub ed25519.PublicKey) string {
	return "did:agentid:" + base58encode(pub)
}

const b58alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func base58encode(b []byte) string {
	if len(b) == 0 { return "" }
	zeros := 0
	for zeros < len(b) && b[zeros] == 0 { zeros++ }
	// Convert big-endian bytes into base-58 digits
	in := make([]byte, len(b)); copy(in, b)
	encoded := make([]byte, 0, len(b)*138/100+1)
	for start := zeros; start < len(in); {
		var carry int
		for i := start; i < len(in); i++ {
			carry = carry*256 + int(in[i])
			in[i] = byte(carry / 58)
			carry %= 58
		}
		encoded = append(encoded, b58alpha[carry])
		for start < len(in) && in[start] == 0 { start++ }
	}
	// Reverse
	for i, j := 0, len(encoded)-1; i < j; i, j = i+1, j-1 {
		encoded[i], encoded[j] = encoded[j], encoded[i]
	}
	out := strings.Repeat("1", zeros) + string(encoded)
	return out
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body); if err != nil { return nil, err }
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil { return nil, &NetworkError{AgentIDError{Message: err.Error()}} }
	req.Header.Set("x-api-key",  c.apiKey)
	if rdr != nil { req.Header.Set("content-type", "application/json") }
	req.Header.Set("user-agent", "agentid-go/0.1")

	res, err := c.http.Do(req)
	if err != nil { return nil, &NetworkError{AgentIDError{Message: err.Error()}} }
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode == 204 { return nil, nil }
	if res.StatusCode >= 400 {
		return nil, raise(res.StatusCode, data)
	}
	return data, nil
}

func raise(status int, body []byte) error {
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	detail := parsed["detail"]
	if obj, ok := detail.(map[string]any); ok && obj["error"] == "tier_required" {
		return &TierError{
			AgentIDError: AgentIDError{
				Message: stringDefault(obj["message"], "Tier upgrade required"),
				Status:  status,
				Detail:  obj,
			},
			CurrentTier:  stringDefault(obj["current_tier"], ""),
			RequiredTier: stringDefault(obj["required_tier"], ""),
			UpgradeURL:   stringDefault(obj["upgrade_url"], ""),
		}
	}
	msg := fmt.Sprintf("HTTP %d", status)
	if s, ok := detail.(string); ok { msg = s }
	switch status {
	case 401, 403: return &AuthError      {AgentIDError{Message: msg, Status: status, Detail: detail}}
	case 429:      return &RateLimitError {AgentIDError{Message: msg, Status: status, Detail: detail}}
	case 402:      return &TierError      {AgentIDError: AgentIDError{Message: msg, Status: status, Detail: detail}}
	}
	return &AgentIDError{Message: msg, Status: status, Detail: detail}
}

func stringDefault(v any, dflt string) string {
	if s, ok := v.(string); ok && s != "" { return s }
	return dflt
}

// ── Resources ────────────────────────────────────────────────────────────────

type AgentsResource     struct{ c *Client }
type AuditResource      struct{ c *Client }
type AnomaliesResource  struct{ c *Client }
type BenchmarksResource struct{ c *Client }
type WebhooksResource   struct{ c *Client }

type CreateAgentParams struct {
	Name         string
	Owner        string  // optional — defaults to your account email
	Capabilities []string
	Private      bool
	Metadata     map[string]any
}

func (r *AgentsResource) Create(ctx context.Context, p CreateAgentParams) (*Agent, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil { return nil, err }
	did := publicKeyToDID(pub)
	owner := p.Owner
	if owner == "" {
		me, err := r.c.Me(ctx); if err != nil { return nil, err }
		owner = me["owner"].(string)
	}
	body := map[string]any{
		"did":          did,
		"name":         p.Name,
		"owner":        owner,
		"public_key":   base64.StdEncoding.EncodeToString(pub),
		"capabilities": orEmpty(p.Capabilities),
		"created_at":   time.Now().UTC().Format(time.RFC3339Nano),
		"metadata":     orEmptyMap(p.Metadata),
		"private":      p.Private,
	}
	canonical, _ := canonicalJSON(body)
	body["proof"] = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canonical))
	if _, err := r.c.request(ctx, "POST", "/agents", body); err != nil { return nil, err }
	return &Agent{
		DID:           did,
		Name:          p.Name,
		Owner:         owner,
		PublicKey:     body["public_key"].(string),
		Capabilities:  orEmpty(p.Capabilities),
		CreatedAt:     body["created_at"].(string),
		Metadata:      orEmptyMap(p.Metadata),
		Private:       p.Private,
		// Store the FULL key (seed||pub, 64 bytes) so future Sign() calls work
		PrivateKeyB64: base64.StdEncoding.EncodeToString(priv),
	}, nil
}

func (r *AgentsResource) Get(ctx context.Context, did string) (*Agent, error) {
	data, err := r.c.request(ctx, "GET", "/agents/"+did, nil)
	if err != nil { return nil, err }
	var a Agent
	if err := json.Unmarshal(data, &a); err != nil { return nil, err }
	return &a, nil
}

func (r *AgentsResource) List(ctx context.Context, page, perPage int) ([]Agent, error) {
	if page < 1 { page = 1 }
	if perPage < 1 { perPage = 50 }
	data, err := r.c.request(ctx, "GET",
		fmt.Sprintf("/pro/search?page=%d&per_page=%d", page, perPage), nil)
	if err != nil { return nil, err }
	var resp struct{ Agents []Agent `json:"agents"` }
	if err := json.Unmarshal(data, &resp); err != nil { return nil, err }
	return resp.Agents, nil
}

type VerifyResult struct {
	Valid      bool   `json:"valid"`
	DID        string `json:"did"`
	Reason     string `json:"reason"`
	Revoked    bool   `json:"revoked"`
	Deprecated bool   `json:"deprecated"`
}

func (r *AgentsResource) Verify(ctx context.Context, did string, payload map[string]any,
	signature, verifierDID string) (VerifyResult, error) {
	body := map[string]any{"payload": payload, "signature": signature}
	if verifierDID != "" { body["verifier_did"] = verifierDID }
	data, err := r.c.request(ctx, "POST", "/agents/"+did+"/verify", body)
	if err != nil { return VerifyResult{}, err }
	var out VerifyResult
	if err := json.Unmarshal(data, &out); err != nil { return VerifyResult{}, err }
	return out, nil
}

func (r *AgentsResource) Deregister(ctx context.Context, agent *Agent) error {
	if agent.PrivateKeyB64 == "" {
		return errors.New("agent has no private key")
	}
	priv, err := base64.StdEncoding.DecodeString(agent.PrivateKeyB64)
	if err != nil { return err }
	if len(priv) == ed25519.SeedSize { priv = ed25519.NewKeyFromSeed(priv) }
	payload := map[string]any{
		"action":    "deregister",
		"did":       agent.DID,
		"timestamp": time.Now().Unix(),
		"nonce":     randomHex(16),
	}
	canonical, _ := canonicalJSON(payload)
	body := map[string]any{
		"payload":   payload,
		"signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canonical)),
	}
	_, err = r.c.request(ctx, "DELETE", "/agents/"+agent.DID, body)
	return err
}

func (c *Client) Me(ctx context.Context) (map[string]any, error) {
	data, err := c.request(ctx, "GET", "/pro/keys/me", nil)
	if err != nil { return nil, err }
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil { return nil, err }
	return out, nil
}

func (r *AuditResource) Recent(ctx context.Context, limit, offset int) ([]map[string]any, error) {
	if limit  <= 0 { limit  = 100 }
	if offset <  0 { offset = 0 }
	data, err := r.c.request(ctx, "GET",
		fmt.Sprintf("/pro/audit-log/json?limit=%d&offset=%d", limit, offset), nil)
	if err != nil { return nil, err }
	var resp struct{ Logs []map[string]any `json:"logs"` }
	if err := json.Unmarshal(data, &resp); err != nil { return nil, err }
	return resp.Logs, nil
}

func (r *AnomaliesResource) List(ctx context.Context) ([]map[string]any, error) {
	data, err := r.c.request(ctx, "GET", "/pro/anomalies", nil)
	if err != nil { return nil, err }
	var resp struct{ Anomalies []map[string]any `json:"anomalies"` }
	if err := json.Unmarshal(data, &resp); err != nil { return nil, err }
	return resp.Anomalies, nil
}

func (r *BenchmarksResource) Get(ctx context.Context) (map[string]any, error) {
	data, err := r.c.request(ctx, "GET", "/pro/benchmarks", nil)
	if err != nil { return nil, err }
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil { return nil, err }
	return out, nil
}

func (r *WebhooksResource) List(ctx context.Context) ([]map[string]any, error) {
	data, err := r.c.request(ctx, "GET", "/pro/webhooks", nil)
	if err != nil { return nil, err }
	var out []map[string]any
	if err := json.Unmarshal(data, &out); err != nil { return nil, err }
	return out, nil
}

func (r *WebhooksResource) Create(ctx context.Context, url string, events []string, secret string) (map[string]any, error) {
	body := map[string]any{"url": url, "events": events}
	if secret != "" { body["secret"] = secret }
	data, err := r.c.request(ctx, "POST", "/pro/webhooks", body)
	if err != nil { return nil, err }
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil { return nil, err }
	return out, nil
}

func (r *WebhooksResource) Delete(ctx context.Context, id string) error {
	_, err := r.c.request(ctx, "DELETE", "/pro/webhooks/"+id, nil)
	return err
}

func orEmpty(s []string) []string {
	if s == nil { return []string{} }
	return s
}
func orEmptyMap(m map[string]any) map[string]any {
	if m == nil { return map[string]any{} }
	return m
}

// ── Capability Contracts ──────────────────────────────────────────────────────

// CapabilityContractsResource provides methods for managing signed Capability
// Contracts — machine-readable, cryptographically signed commitments that
// specify what an agent can do, its SLA, pricing, and remedies on failure.
type CapabilityContractsResource struct{ c *Client }

// CapabilityContractParams holds the fields needed to create a contract.
type CapabilityContractParams struct {
	Capability   string         // required — e.g. "web-search"
	Version      string         // defaults to "1.0"
	Description  string
	InputSchema  map[string]any // JSON schema for the input
	OutputSchema map[string]any // JSON schema for the output
	SLA          map[string]any // e.g. {"max_latency_seconds": 5, "availability_target": 0.99}
	Pricing      map[string]any // e.g. {"model": "per_call", "price_usd": 0.001}
	Remedies     map[string]any // e.g. {"on_sla_breach": "refund"}
}

// CapabilityContract is the server representation of a registered contract.
type CapabilityContract struct {
	ID           int64          `json:"id"`
	DID          string         `json:"did"`
	Capability   string         `json:"capability"`
	Version      string         `json:"version"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"input_schema"`
	OutputSchema map[string]any `json:"output_schema"`
	SLA          map[string]any `json:"sla"`
	Pricing      map[string]any `json:"pricing"`
	Remedies     map[string]any `json:"remedies"`
	Signature    string         `json:"signature"`
	SignedAt     string         `json:"signed_at"`
	IsActive     bool           `json:"is_active"`
	CreatedAt    string         `json:"created_at"`
	ContractURL  string         `json:"contract_url"`
}

// Sign builds the canonical contract body and signs it with the agent's
// Ed25519 private key. Returns a map ready to POST to the registry.
//
// The canonical form (sort_keys, no spaces) matches the server's verification
// in capability_contracts._verify_contract_signature().
func (r *CapabilityContractsResource) Sign(agent *Agent, p CapabilityContractParams) (map[string]any, error) {
	if agent.PrivateKeyB64 == "" {
		return nil, errors.New("agent has no private key — was it loaded from a remote fetch?")
	}
	if p.Version == "" { p.Version = "1.0" }

	body := map[string]any{
		"did":           agent.DID,
		"capability":    p.Capability,
		"version":       p.Version,
		"description":   p.Description,
		"input_schema":  orEmptyMap(p.InputSchema),
		"output_schema": orEmptyMap(p.OutputSchema),
		"sla":           orEmptyMap(p.SLA),
		"pricing":       func() map[string]any {
			if p.Pricing == nil { return map[string]any{"model": "free"} }
			return p.Pricing
		}(),
		"remedies": orEmptyMap(p.Remedies),
	}

	priv, err := base64.StdEncoding.DecodeString(agent.PrivateKeyB64)
	if err != nil { return nil, fmt.Errorf("decode private key: %w", err) }
	if len(priv) == ed25519.SeedSize { priv = ed25519.NewKeyFromSeed(priv) }

	canonical, err := canonicalJSON(body)
	if err != nil { return nil, err }
	sig := ed25519.Sign(priv, canonical)

	result := clone(body)
	result["signature"] = base64.StdEncoding.EncodeToString(sig)
	result["signed_at"] = time.Now().UTC().Format(time.RFC3339)
	return result, nil
}

// Publish signs a contract and POSTs it to the registry in one call.
//
//	contract, err := client.CapabilityContracts.Publish(ctx, agent, CapabilityContractParams{
//	    Capability: "web-search",
//	    SLA:        map[string]any{"max_latency_seconds": 5, "availability_target": 0.99},
//	    Pricing:    map[string]any{"model": "per_call", "price_usd": 0.001},
//	    Remedies:   map[string]any{"on_sla_breach": "refund"},
//	})
func (r *CapabilityContractsResource) Publish(
	ctx context.Context, agent *Agent, p CapabilityContractParams,
) (*CapabilityContract, error) {
	body, err := r.Sign(agent, p)
	if err != nil { return nil, err }

	data, err := r.c.request(ctx, "POST",
		"/agents/"+agent.DID+"/capability-contracts", body)
	if err != nil { return nil, err }

	var resp struct{ Contract *CapabilityContract `json:"contract"` }
	if err := json.Unmarshal(data, &resp); err != nil { return nil, err }
	return resp.Contract, nil
}

// List fetches all active Capability Contracts for a DID (public, no auth needed).
func (r *CapabilityContractsResource) List(
	ctx context.Context, did string,
) ([]CapabilityContract, error) {
	data, err := r.c.request(ctx, "GET",
		"/agents/"+did+"/capability-contracts", nil)
	if err != nil { return nil, err }

	var resp struct{ Contracts []CapabilityContract `json:"contracts"` }
	if err := json.Unmarshal(data, &resp); err != nil { return nil, err }
	return resp.Contracts, nil
}

// Get fetches the latest active contract for a specific capability (public).
func (r *CapabilityContractsResource) Get(
	ctx context.Context, did, capability string,
) (*CapabilityContract, error) {
	data, err := r.c.request(ctx, "GET",
		"/agents/"+did+"/capability-contracts/"+capability, nil)
	if err != nil { return nil, err }

	var out CapabilityContract
	if err := json.Unmarshal(data, &out); err != nil { return nil, err }
	return &out, nil
}

// Deactivate soft-deletes a contract. Pass an empty version to deactivate all versions.
func (r *CapabilityContractsResource) Deactivate(
	ctx context.Context, did, capability, version string,
) error {
	path := "/agents/" + did + "/capability-contracts/" + capability
	if version != "" { path += "?version=" + version }
	_, err := r.c.request(ctx, "DELETE", path, nil)
	return err
}

// ContractSearchOptions filters for SearchContracts.
type ContractSearchOptions struct {
	Capability       string
	PricingModel     string  // free | per_call | subscription | tiered
	MaxLatencyMS     float64 // 0 = no filter
	AvailabilityMin  float64 // 0 = no filter
	SignedOnly        bool
	Limit             int
	Offset            int
}

// Search finds Capability Contracts across all public agents.
func (r *CapabilityContractsResource) Search(
	ctx context.Context, opts ContractSearchOptions,
) ([]CapabilityContract, int, error) {
	q := fmt.Sprintf("/capability-contracts/search?limit=%d&offset=%d",
		func() int { if opts.Limit <= 0 { return 50 }; return opts.Limit }(),
		opts.Offset,
	)
	if opts.Capability    != "" { q += "&capability="    + opts.Capability }
	if opts.PricingModel  != "" { q += "&pricing_model=" + opts.PricingModel }
	if opts.MaxLatencyMS  > 0   { q += fmt.Sprintf("&max_latency_ms=%g",    opts.MaxLatencyMS) }
	if opts.AvailabilityMin > 0 { q += fmt.Sprintf("&availability_min=%g",  opts.AvailabilityMin) }
	if opts.SignedOnly          { q += "&signed_only=true" }

	data, err := r.c.request(ctx, "GET", q, nil)
	if err != nil { return nil, 0, err }

	var resp struct {
		Results []CapabilityContract `json:"results"`
		Total   int                  `json:"total"`
	}
	if err := json.Unmarshal(data, &resp); err != nil { return nil, 0, err }
	return resp.Results, resp.Total, nil
}
