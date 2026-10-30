// S3-compatible storage (AWS S3, MinIO; adapt for Azure Blob / GCS). Files go straight to storage via signed URLs.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3 = new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } });
exports.ALLOWED = { 'video/mp4': 2e9, 'application/pdf': 50e6, 'image/png': 5e6, 'image/jpeg': 5e6,
  'application/vnd.ms-powerpoint': 50e6, 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 50e6,
  'application/msword': 25e6, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25e6 };
exports.uploadUrl = (key, type) => getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: type }), { expiresIn: 600 });
exports.downloadUrl = (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn: 600 });
