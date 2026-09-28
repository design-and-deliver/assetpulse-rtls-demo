# Architecture decision records

Each record is one page or less, and each one names the conditions under which the decision
would flip.

| #    | Decision                                                                      | Status   |
| ---- | ----------------------------------------------------------------------------- | -------- |
| 0001 | [WebSockets, not SSE or polling](0001-websockets-vs-sse-vs-polling.md)        | Accepted |
| 0002 | [Raw `ws`, not SignalR / Web PubSub](0002-raw-ws-vs-signalr-web-pubsub.md)    | Accepted |
| 0003 | [Two streams: events vs positions](0003-two-streams.md)                       | Accepted |
| 0004 | [Where APIM and Entra ID would sit](0004-apim-entra-placement.md)             | Proposed |
| 0005 | [ServiceNow and Snowflake as adapters](0005-servicenow-snowflake-adapters.md) | Accepted |
