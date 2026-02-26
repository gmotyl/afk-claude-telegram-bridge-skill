#!/usr/bin/env python3
"""
/poll command — Check for pending Telegram instructions in AFK mode
"""
import json
import os

BRIDGE_DIR = os.path.expanduser("~/.claude/hooks/telegram-bridge")
STATE_PATH = os.path.join(BRIDGE_DIR, "state.json")
IPC_DIR = os.path.join(BRIDGE_DIR, "ipc")


def find_active_session():
    """Find the current active AFK session ID"""
    try:
        with open(STATE_PATH) as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    
    slots = state.get("slots", {})
    if not slots:
        return None
    
    # Return first active session
    for slot_num, info in slots.items():
        return info.get("session_id")
    
    return None


def poll_instructions(clear_after=True):
    """Check and retrieve pending instructions from Telegram"""
    session_id = find_active_session()
    
    if not session_id:
        return None
    
    ipc_session_dir = os.path.join(IPC_DIR, session_id)
    instruction_file = os.path.join(ipc_session_dir, "queued_instruction.json")
    
    if not os.path.isfile(instruction_file):
        return None
    
    try:
        with open(instruction_file) as f:
            data = json.load(f)
        
        instruction = data.get("instruction", "")
        
        # Clear instruction after reading
        if clear_after and instruction:
            try:
                os.remove(instruction_file)
            except:
                pass
        
        return instruction
    except:
        return None


if __name__ == "__main__":
    instruction = poll_instructions()
    if instruction:
        print(f"\n📱 **Telegram Instruction:**\n```\n{instruction}\n```\n")
    else:
        print("✓ No pending instructions from Telegram")
