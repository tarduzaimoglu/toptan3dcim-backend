export default ({ env }) => ({
  upload: {
    config: {
      provider: '@strapi/provider-upload-aws-s3',
      providerOptions: {
        baseUrl: env('SUPABASE_PUBLIC_URL'),
        s3Options: {
          credentials: {
            accessKeyId: env('SUPABASE_S3_ACCESS_KEY_ID'),
            secretAccessKey: env('SUPABASE_S3_SECRET_ACCESS_KEY'),
          },
          region: env('SUPABASE_S3_REGION'),
          endpoint: env('SUPABASE_S3_ENDPOINT'),
          forcePathStyle: true,
        },
        params: {
          Bucket: env('SUPABASE_S3_BUCKET'),
        },
      },
    },
  },
});