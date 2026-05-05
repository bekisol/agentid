# agentid-go

[![Go Reference](https://pkg.go.dev/badge/github.com/bekisol/agentid/sdk/go.svg)](https://pkg.go.dev/github.com/bekisol/agentid/sdk/go)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go 1.21+](https://img.shields.io/badge/go-1.21+-00ADD8.svg)](https://go.dev/)

Official Go SDK for [AgentID Protocol](https://agentid-protocol.com) — identity layer for AI agents.

```bash
go get github.com/bekisol/agentid/sdk/go
```

## Quickstart

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    agentid "github.com/bekisol/agentid/sdk/go"
)

func main() {
    ctx := context.Background()
    client, err := agentid.NewClient(agentid.Options{
        APIKey: os.Getenv("AGENTID_API_KEY"),
    })
    if err != nil { log.Fatal(err) }

    // Register a new agent (keypair generated locally, never sent over the wire)
    agent, err := client.Agents.Create(ctx, agentid.CreateAgentParams{
        Name:         "customer-support-bot",
        Capabilities: []string{"chat", "search"},
    })
    if err != nil { log.Fatal(err) }
    fmt.Println(agent.DID)             // did:agentid:abc...
    fmt.Println(agent.PrivateKeyB64)   // store this — server never sees it again

    // Sign and verify a message
    signed, _ := agent.Sign(map[string]any{"message": "hello"})
    result, _ := client.Agents.Verify(ctx, agent.DID, signed.Payload, signed.Signature, "")
    fmt.Println(result.Valid)          // true

    // List your agents
    agents, _ := client.Agents.List(ctx, 1, 50)
    for _, a := range agents { fmt.Println(a.DID, a.Name) }
}
```

## Configuration

```go
client, _ := agentid.NewClient(agentid.Options{
    APIKey:  "agentid_...",
    BaseURL: "https://api.agentid-protocol.com",   // default
    Timeout: 15 * time.Second,                     // default
})
```

## Errors

```go
agent, err := client.Agents.Create(ctx, params)
if err != nil {
    if te, ok := err.(*agentid.TierError); ok {
        fmt.Println("Need to upgrade:", te.UpgradeURL)
    } else if _, ok := err.(*agentid.AuthError); ok {
        fmt.Println("Invalid key")
    }
}
```

## License

MIT
