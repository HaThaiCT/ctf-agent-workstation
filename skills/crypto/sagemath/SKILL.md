---
name: sagemath-crypto-solvers
description: Solve advanced CTF cryptography challenges using SageMath. Use when attacking RSA (Coppersmith, partial key, Franklin-Reiter), elliptic curve cryptography (ECDSA, curve point addition, discrete log), lattice-based cryptography (LLL, CVP, SVP), or finite field mathematics.
---

# SageMath Cryptography Solvers

SageMath provides advanced mathematical tooling for breaking RSA, Elliptic Curves, and Lattice problems.

## Execution Pattern

Run Sage scripts non-interactively using:
```bash
sage solve.sage
# or inline:
sage -c 'p = random_prime(2^512); print(p)'
```

## Common CTF Attack Patterns

### 1. Lattice Reduction (LLL)
Solve hidden linear equations or knapsack problems:
```python
# solve.sage
from sage.all import *

M = Matrix(ZZ, [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 10]
])
reduced = M.LLL()
print(reduced)
```

### 2. RSA Coppersmith's Small Roots
Find small roots of monic polynomials modulo $N$:
```python
# solve.sage
from sage.all import *

N = 0x...
e = 3
P.<x> = PolynomialRing(Zmod(N))
# Known prefix attack: flag = (known_prefix << bits) + x
f = (known_val + x)^e - c
roots = f.small_roots(X=2^128, beta=0.5)
if roots:
    print("Found root:", roots[0])
```

### 3. Discrete Logarithm (Pohlig-Hellman / BSGS)
```python
from sage.all import *

p = 1000000007
F = GF(p)
g = F(5)
h = F(123456)
x = discrete_log(h, g)
print("x =", x)
```

### 4. Elliptic Curves
```python
from sage.all import *

# Define curve y^2 = x^3 + a*x + b over GF(p)
E = EllipticCurve(GF(p), [a, b])
P = E(x1, y1)
Q = E(x2, y2)
# Order and discrete log on curve
order = E.order()
d = discrete_log(Q, P, operation='+')
print("Private key d =", d)
```
