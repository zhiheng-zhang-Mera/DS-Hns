# Installed dependency license inventory

Verified from the installed distribution metadata and shipped license files of the exact versions in `requirements.lock`, using `D:/temp/ecq-v37-python/Scripts/python.exe` and Python `importlib.metadata`. No dependency implementation or dependency wheel is copied by this inventory. Installation remains separate from the project's own MIT-licensed ECQ source. The standard-library-only stored-output reanalysis does not require these packages; live SHACL execution does.

| Distribution | Exact installed version | Declared license | Metadata / upstream source |
|---|---:|---|---|
| `html5rdf` | `1.2.1` | `MIT` | https://github.com/RDFLib/html5rdf |
| `owlrl` | `7.6.2` | `W3C-20150513` | https://github.com/RDFLib/OWL-RL |
| `packaging` | `26.3` | `Apache-2.0 OR BSD-2-Clause` | https://github.com/pypa/packaging |
| `prettytable` | `3.18.0` | `BSD-3-Clause` | https://github.com/prettytable/prettytable |
| `pyparsing` | `3.3.3` | `MIT` | https://github.com/pyparsing/pyparsing.git |
| `pyshacl` | `0.40.1` | `Apache-2.0` | https://github.com/RDFLib/pySHACL |
| `PyYAML` | `6.0.3` | `MIT` | https://github.com/yaml/pyyaml |
| `rdflib` | `7.6.0` | `BSD-3-Clause` | https://github.com/RDFLib/rdflib |
| `wcwidth` | `0.9.4` | `MIT` | installed METADATA |

The license labels follow `License-Expression` when available; otherwise the installed `License`/classifier and actual notice text were checked. For `packaging`, the alternative Apache-2.0 and BSD-2-Clause texts are both shipped by the distribution. `owlrl` declares W3C-20150513. Full copyright and permission terms remain in the upstream distributions; this inventory neither substitutes an invented copyright statement nor applies the DS-Hns MIT license to those packages.

## Verified installed notice objects

- `html5rdf-1.2.1.dist-info/LICENSE` — SHA-256 `16a39991619e92f18680932da2a9199fdf7d95df3ecaedc52ea06218aabafd6f`.
- `owlrl-7.6.2.dist-info/LICENSE.txt` — SHA-256 `4314f05aad7a217e792d310af1b4381d132e03d2f823c29bb7ab0f87c6849257`.
- `packaging-26.3.dist-info/licenses/LICENSE` — SHA-256 `cad1ef5bd340d73e074ba614d26f7deaca5c7940c3d8c34852e65c4909686c48`.
- `packaging-26.3.dist-info/licenses/LICENSE.APACHE` — SHA-256 `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594`.
- `packaging-26.3.dist-info/licenses/LICENSE.BSD` — SHA-256 `b70e7e9b742f1cc6f948b34c16aa39ffece94196364bc88ff0d2180f0028fac5`.
- `prettytable-3.18.0.dist-info/licenses/LICENSE` — SHA-256 `0c8adcc204c8af6cdfdf7887dfd1f99c29901f6c1d505a78bba96efa4fb2cb05`.
- `pyparsing-3.3.3.dist-info/licenses/LICENSE` — SHA-256 `a5425f9dc14ac74d4c5f0b679e941f2442e32cca7452a4418d5b1a49893ebe4e`.
- `pyshacl-0.40.1.dist-info/licenses/LICENSE.txt` — SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
- `pyyaml-6.0.3.dist-info/licenses/LICENSE` — SHA-256 `8d3928f9dc4490fd635707cb88eb26bd764102a7282954307d3e5167a577e8a4`.
- `rdflib-7.6.0.dist-info/LICENSE` — SHA-256 `53a705e51bfd199e8c97d0442376cb4bbd4ffcf13ba4f2c4c2794211400e4012`.
- `wcwidth-0.9.4.dist-info/licenses/LICENSE` — SHA-256 `dff08668b8cfca00ec90011eb318e450c3719fcd40893bf375781a6beef7143a`.

## Archived third-party workflow files

The unmodified pytest and Fastify workflow source snapshots are accompanied by their projects' representative commit-pinned MIT notices at `artifacts/paper-revision/ecq-v37/sources/THIRD_PARTY_LICENSES/`. The adjacent README records original URLs, commits and byte digests. No pre-existing frozen source or checksum file was changed for this notice addition.
