class IP:
    ip: str | tuple[str, int, int]

class Adapter:
    name: str
    nice_name: str
    ips: list[IP]

def get_adapters() -> list[Adapter]: ...
