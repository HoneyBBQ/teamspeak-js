---
"@honeybbq/teamspeak": patch
---

Packet encryption costs less CPU. The authentication tag (AES-CMAC) created a cipher for every 16-byte block and derived its subkeys again for every packet; it now runs one AES-CBC pass per message and derives the subkeys once per key. Encrypting and decrypting a 60-byte voice packet takes about a third of the time it did, and a 500-byte command packet about a tenth.
