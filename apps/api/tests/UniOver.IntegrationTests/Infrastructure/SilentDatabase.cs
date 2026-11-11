using System.Net;
using System.Net.Sockets;

namespace UniOver.IntegrationTests.Infrastructure;

/// <summary>
/// Um "banco" local que aceita a conexão e nunca responde: prova, sem relógio e sem DNS, que alguém ficou esperando o banco
/// (<see cref="Accepted"/>). Ao descartar, as conexões caem e quem esperava falha na hora; uma conexão que chega depois do
/// descarte é fechada na hora.
/// </summary>
public sealed class SilentDatabase : IDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly List<TcpClient> clients = [];
    private readonly TaskCompletionSource accepted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly CancellationTokenSource stop = new();
    private bool disposed;

    public SilentDatabase()
    {
        listener.Start();
        _ = AcceptLoopAsync();
    }

    /// <summary>Conclui quando a primeira conexão chega.</summary>
    public Task Accepted => accepted.Task;

    /// <summary>Cadeia de conexão do Npgsql apontando para este ouvinte (prazo largo: quem a derruba é o descarte).</summary>
    public string ConnectionString =>
        $"Host=127.0.0.1;Port={((IPEndPoint)listener.LocalEndpoint).Port};Database=d;Username=u;Password=segredo-do-banco;Timeout=60;Pooling=false";

    public void Dispose()
    {
        List<TcpClient> toClose;
        lock (clients)
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            toClose = [.. clients];
            clients.Clear();
        }

        stop.Cancel();
        listener.Stop();
        foreach (var client in toClose)
        {
            client.Dispose();
        }

        stop.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(stop.Token);
                var keep = false;
                lock (clients)
                {
                    if (!disposed)
                    {
                        clients.Add(client);
                        keep = true;
                    }
                }

                if (!keep)
                {
                    // Chegou depois do descarte: ninguém mais o fecharia.
                    client.Dispose();
                    return;
                }

                accepted.TrySetResult();
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException)
        {
            // Descartado: não há mais o que aceitar.
        }
    }
}
