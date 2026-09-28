import subprocess
from functools import lru_cache
from pathlib import Path
from voice_cache import DEFAULT_SOURCE, DEFAULT_DECODER, probe_bank


@lru_cache(maxsize=1)
def catalog():
    rows = probe_bank(DEFAULT_DECODER, DEFAULT_SOURCE.parent/'temp/temp.acb')
    result = {r['name']: (DEFAULT_SOURCE.parent/'temp/temp.acb', r['index']) for r in rows
              if r['name'].startswith(('LycorisRadiata_', 'Machairodus_'))}
    result['LycorisRadiata_Music_01'] = (DEFAULT_SOURCE.parent/'bgms/LycorisRadiata_Music_01.acb', 1)
    return result


def decode(name: str, cache: Path):
    source, index = catalog()[name]
    folder = cache/'spine-ui-audio';folder.mkdir(exist_ok=True)
    target = folder/(name+'.wav')
    if not target.exists():
        temp = folder/(name+'.tmp.wav')
        subprocess.run([str(DEFAULT_DECODER),'-s',str(index),'-o',str(temp),str(source)],check=True,capture_output=True,timeout=60)
        temp.replace(target)
    return target
