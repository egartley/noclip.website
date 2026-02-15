import struct
import os
import glob

SIGNATURE_MAP = [
    (b"\x56\x41\x47\x70", "VAG"),
    (b"\x01\x06\x45\x44\x44\x44\x44\x44\x44\x44\x44\x44\x44\x33\x33\x33", "VAG"),
    (b"\x20\x31\x30\x20\x20\x20\x20\x20\x20\x30\x20\x20\x20\x20\x20\x20\x3A", "LANG"),
    (b"\x20\x40\x40\x40\x40\x21\x80", "DATCON"),
    (b"\x20\x40\x40\x40\x40\x01\x80", "DATCON"),
    (b"\x56\x65\x72\x73\x69\x6F\x6E\x20\x34", "VAGDESC"),
    (b"\x42\x45\x47\x49\x4E\x20\x55\x56\x43\x4F\x4F\x52\x44\x53", "FONTDESC"),
    (b"\x30\x89\xD7\xDA\x45\xEF\xFD\x19", "MRB"),
    (b"\xF6\xF5\x67\xBC\xF0\xDC\xDD", "MRB"),
    (b"\xFF\xFF\xFF\xFF", "DAT1"),
    (b"\x53\x63\x65\x6E\x65", "SCENEDESC"),
    (b"\x52\x65\x6E\x64\x65\x72\x41\x6C\x6C\x50\x61\x72\x74\x69\x63\x6C\x65\x73", "SCENEDESC"),
    (b"\x04\x00\x00\x00\x00\x00\x00\x10\x0E\x00\x00\x00\x00\x00\x00\x00", "DAT2"),
    (b"\x00\x00\x56\x22\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00", "DAT3"),
    (b"\x23\x20\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A\x2A", "CFG")
]

FILE_ID_MAP = {
    "3762881A": "g_gem",
    "7E11E495": "p_gem",
    "BA8B1E06": "y_gem",
    "95591DB4": "r_gem",
    "8F46ABF6": "gemicon",
    "C07DD248": "ui1",
    "70FBE9DB": "font1",
    "3B45F675": "key_light",
    "390EC8C5": "common1",
    "17674F03": "filenames1",
    "25113362": "commonsound1",
    "7AFC88B1": "common2",
    "B118FB79": "common3",
    "41D78ED5": "common4",
    "22CC27DD": "sparx_icon"
}

def identify_extension(data):
    stripped_data = data.lstrip(b'\x00')
    if not stripped_data:
        return "bin"
    for sig, ext in SIGNATURE_MAP:
        sig_len = len(sig)
        if len(stripped_data) >= (sig_len + 32):
            if sig in stripped_data[:32]:
                return ext
    return "bin"

def identify_file_id(data):
    for signature, name in FILE_ID_MAP.items():
        if data == signature:
            return name
    return data

def extract_single_archive(file_path):
    base_name = os.path.basename(file_path)
    folder_name = f"./extract/{os.path.splitext(base_name)[0]}"

    if not os.path.exists(folder_name):
        os.makedirs(folder_name)

    print(f"--- Processing: {base_name} ---")

    with open(file_path, 'rb') as f:
        f.seek(0x0C)
        count_data = f.read(4)
        if len(count_data) < 4:
            return

        file_count = struct.unpack('<I', count_data)[0]
        
        for i in range(file_count):
            entry_data = f.read(16)
            if len(entry_data) < 16:
                break
            file_id, offset, size, _ = struct.unpack('<IIII', entry_data)
            toc_position = f.tell()
            if size > 16:
                f.seek(offset)
                payload = f.read(size)
                extension = identify_extension(payload)
                name = identify_file_id(f"{file_id:08X}")
                out_name = f"{i + 1}_{name}.{extension}"
                with open(os.path.join(folder_name, out_name), 'wb') as out_file:
                    out_file.write(payload)
            f.seek(toc_position)

    print(f"Done. Processed {file_count} files.\n")

def process_folder(input_folder, extension):
    search_pattern = os.path.join(input_folder, f"*{extension}")
    archive_files = glob.glob(search_pattern)
    
    if not archive_files:
        print(f"No {extension} files found in {input_folder}")
        return

    for archive in archive_files:
        try:
            extract_single_archive(archive)
        except Exception as e:
            print(f"Failed to process {archive}: {e}")

# if __name__ == "__main__":
#     process_folder("./raw/SPYRODAT/CHUNKS", ".CNK")
#     process_folder("./raw/SPYRODAT/CHUNKS2", ".CNK")
#     process_folder("./raw/SPYRODAT/CHUNKS3", ".CNK")
