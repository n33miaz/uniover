from enum import Enum

class IPVersion(Enum):
    V4Only = 1

class ServiceStateChange(Enum):
    Added = 1
    Removed = 2

class Zeroconf: ...
