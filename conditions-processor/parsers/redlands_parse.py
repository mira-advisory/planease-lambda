from pypdf import PdfReader
import re

def parse_redlands_conditions_pdf(file_bytes):
    reader = PdfReader(file_bytes)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    # Parse however you need (same as Logan if similar)
    # This is placeholder structure
    return {
        "sections": [],
        "raw": text[:2000]  # send first 2k chars so frontend can see output
    }
