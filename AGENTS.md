# LivT Fee Payer

This service holds only LivT's dedicated gas-sponsor key. It never handles a
user mnemonic, private key, wallet password, or LivT login credential.

## Secrets

- Never read, print, log, copy, commit, or modify `.env`.
- Never log sender-signed or fully signed raw transactions.
- Never expose the fee-payer private key or internal API key in an error.
- Use `.env.example` only for variable names and safe defaults.

## Network safety

- The Kairos proof server binds to literal `127.0.0.1` only.
- A broadcast request must never be automatically retried.
- Receipt polling may retry because it cannot create another transaction.
- Keep chain ID, transaction type, token contract, value, gas, and calldata
  policy checks in place.
