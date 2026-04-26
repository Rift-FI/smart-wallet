import crypto, { createHash } from "node:crypto";
import { ethers } from 'ethers';

let key1="85f2bbc05553cf02990b8a93cbfa4259:2c9278b66364a0fc7b4a38aa3e3e52b5e19d066435945bf80d1b38760ca61d0556253bf646aa1d5255f232fb7c692c6d0ccc2a25202de7c797b8b30ec5de781a70c0428884214781c80916471d47c785"
let key2="7b18a20583b47c049fc8a0b1b81c1e9e:107970b38ea040ee50abf700148bda3b3476be31cdb90992ec3eaef74d33a839c9f46a703ce7c54b9f207cb5cf65b78b064c086f65ecc20d14356fbd771a0125ed8a297f56c03d8b060474a645312258"
let secret="89b0dba4b7eacc5d778d516e671aff6ff4ff83a8dfd741f2f4bec1c6ba072f39"

export function decrypt(encryptedText, secretKey) {
    const key = createHash("sha256").update(String(secretKey)).digest();
    const parts = encryptedText.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedData = parts[1];
  
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  
    let decrypted = decipher.update(encryptedData, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
  
    return decrypted;
}

// Decrypt both keys
const keys = [key1, key2];

keys.forEach((encryptedKey, index) => {
    const decryptedKey = decrypt(encryptedKey, secret);
    console.log(`Key ${index + 1}: ${decryptedKey}`);
});


// Key 1: 0x9063ce8ee9e97c18fd1e967ef7501ecd8a8d4266926b540c5438dbd0103089ec
// Key 2: 0x0c4ae579d361b31680723740efd2dd5db20267503546da0c7960749b69f5dcd3



function privateKeyToAddressEthers(privateKey) {
    // Remove 0x prefix if present
    if (privateKey.startsWith('0x')) {
        privateKey = privateKey.slice(2);
    }
    
    // Create wallet from private key
    const wallet = new ethers.Wallet(privateKey);
    
    return wallet.address;
}

// Example usage:
const privateKey = '0x0c4ae579d361b31680723740efd2dd5db20267503546da0c7960749b69f5dcd3';
console.log('Address:', privateKeyToAddressEthers(privateKey));
