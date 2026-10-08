output "instance_name" {
  value = google_compute_instance.ctf.name
}

output "external_ip" {
  value = google_compute_instance.ctf.network_interface[0].access_config[0].nat_ip
}

output "webapp_url" {
  value       = "http://127.0.0.1:8000"
  description = "Open locally after forwarding SSH port 8000 to the VM."
}
