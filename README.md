# EduLearn LMS backend
Node.js + Express, PostgreSQL, Redis, S3-compatible storage (MinIO locally), Nginx load balancer in front of 3 app servers, plus a background worker.

## Run
1. `cp .env.example .env` and set JWT_SECRET
2. `docker compose up --build -d`
3. `docker compose exec app1 node src/utils/migrate.js`    (applies database/migrations)
4. `docker compose exec app1 node /database/seeds/seed.js` (demo data; every password is demo123)
5. Open http://localhost:8080 (frontend) · API at /api · health at /health · header X-Served-By shows round-robin
6. Failover test: `docker compose stop app2`; requests keep working and skip app2
7. Create the bucket `edulearn` in the MinIO console (http://localhost:9001, minio / minio12345) for uploads

## Layout
backend/src: routes, middleware, jobs (queue + worker), utils (storage, migrate) · database/migrations · infrastructure/nginx
The frontend (edulearn-lms.html) currently uses browser storage; point its data layer at /api/* to use this backend.
