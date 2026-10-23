---
"@honeybbq/teamspeak": patch
---

A fragmented command over the 1 MiB reassembly limit is dropped whole, up to the fragment that ends it. The client used to drop only the fragments it had seen, and read the rest as the start of the next command. The receive queue also takes the packet it needs next when it is full, so a command larger than the queue can reach its last fragment.
