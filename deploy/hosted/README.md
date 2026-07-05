# Hosted Service Target

Run the Saga service as a long-lived container process (direct exec from
`apps/service`, so the service receives platform SIGTERM itself):

```sh
node --import tsx src/main.ts
```

Required runtime contract:

- Inject `DATABASE_URL` or `DATABASE_URL_FILE`.
- Bind `SAGA_SERVICE_HOST=0.0.0.0`.
- Expose `SAGA_SERVICE_PORT`, default `4766`.
- Inject optional provider/API secrets through direct environment variables or `_FILE` indirection.

The hosted target assumes the platform owns process restart, secret delivery, log capture, and database backups.
