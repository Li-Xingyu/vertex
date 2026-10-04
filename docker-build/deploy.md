# Reliability image delivery

See [behavior and cutover requirements](../docs/reliability.md). Required runtime environment variables: none. Optional official variables: `TZ` (Asia/Shanghai), `PORT` (3000), `REDISPORT` (6379), `PUID` and `PGID` (official bootstrap defaults). Keep existing production values rather than adopting new defaults.

No Compose stack or test credential file is generated: Redis and SQLite remain inside the official container. The bootstrap retains its root setup and configurable `vt` application account.

Build explicitly for the NAS architecture:

```sh
docker buildx build --platform linux/amd64 --load \
  -f docker/Dockerfile.reliability -t vertex-reliability-test .
```

To test without production data, published ports, or external network:

```sh
docker run -d --name vertex-reliability-smoke --network none \
  --tmpfs /vertex:rw,nosuid,size=128m -e TZ=Asia/Shanghai vertex-reliability-test
docker exec vertex-reliability-smoke node test/startup-smoke.js
docker inspect vertex-reliability-smoke --format '{{.State.Status}}'
# Remove only this fresh disposable test container after inspection.
docker rm -f vertex-reliability-smoke
```

The ledger schema is added by the database worker before the first SQL request. Regression tests verify that table and the original SQL tables. The application smoke test verifies a real authenticated history query; no credential values are printed.

No NAS deployment is performed by CI. Verify package pull permissions, unresolved intents, current hook compatibility, H&R guards, and shared-file protection before separately approving a production cutover. Do not run two controllers against one production database/downloader.
