using Amazon.S3;
using Amazon.S3.Model;
using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Adapters;

internal sealed class S3ProgressPhotoObjectStore(IAmazonS3 client, ProgressPhotoStorageOptions options) : IProgressPhotoObjectStore
{
    public bool IsAvailable => true;

    public async Task PutAsync(string key, ReadOnlyMemory<byte> content, CancellationToken cancellationToken)
    {
        await using var stream = new MemoryStream(content.ToArray(), writable: false);
        await client.PutObjectAsync(new PutObjectRequest
        {
            BucketName = options.Bucket,
            Key = key,
            InputStream = stream,
            ContentType = "image/jpeg",
            AutoCloseStream = false,
        }, cancellationToken);
    }

    public async Task<Stream?> OpenReadAsync(string key, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await client.GetObjectAsync(options.Bucket, key, cancellationToken);
            var copy = new MemoryStream();
            await response.ResponseStream.CopyToAsync(copy, cancellationToken);
            copy.Position = 0;
            return copy;
        }
        catch (AmazonS3Exception exception) when (exception.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task DeleteAsync(string key, CancellationToken cancellationToken) =>
        await client.DeleteObjectAsync(options.Bucket, key, cancellationToken);
}
