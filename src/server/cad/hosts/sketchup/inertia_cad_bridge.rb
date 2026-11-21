# Inertia CAD Bridge loader. Inertia installs this file and the inertia_cad_bridge
# folder into SketchUp's Plugins folder; remove both to uninstall.
require 'sketchup.rb'
require 'extensions.rb'

module Inertia
  module CadBridge
    unless file_loaded?(__FILE__)
      # SketchUp 2017-2019 ship a Ruby that lacks APIs the bridge relies on.
      if Sketchup.version.to_i < 20
        puts '[Inertia CAD Bridge] needs SketchUp 2020 or newer; not loading.'
      else
        extension = SketchupExtension.new('Inertia CAD Bridge', 'inertia_cad_bridge/main')
        extension.description =
          'Lets agents in Inertia read the open model and apply only the edits you approve.'
        extension.version = '1.1.0'
        extension.creator = 'Inertia'
        Sketchup.register_extension(extension, true)
      end
      file_loaded(__FILE__)
    end
  end
end
